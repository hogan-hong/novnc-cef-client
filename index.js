const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const http = require('http')

// ========== 禁用 DirectComposition，保证GDI截图不黑屏 ==========
app.commandLine.appendSwitch('disable-direct-composition')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('enable-gpu')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

// ========== 全局状态 ==========
let syncEnabled = false
let currentGroupIndex = 1
const vncWindows = []
let apiServer = null
let exitWindow = null
let selectWindow = null

// ★ 主控窗口索引，只有主控窗口的输入会同步到其他窗口
let masterWindowIndex = 0

// ★ Canvas 信息缓存：每个窗口的 canvas 尺寸和位置
const canvasInfoCache = {}

// ========== 读取配置文件 ==========
function readConfig () {
  const searchPaths = [
    path.join(path.dirname(app.getPath('exe')), '配置文件.int'),
    path.join(process.cwd(), '配置文件.int'),
    path.join(app.getAppPath(), '配置文件.int')
  ]
  let configPath = null
  for (const p of searchPaths) { if (fs.existsSync(p)) { configPath = p; break } }
  if (!configPath) return null
  const iconv = require('iconv-lite')
  const content = iconv.decode(fs.readFileSync(configPath), 'gbk')
  const config = { groups: [], items: [] }
  for (let i = 1; i <= 10; i++) {
    const m = content.match(new RegExp(`组${i}名称=(.+)`, 'm'))
    if (m && m[1].trim()) config.groups.push({ index: i, name: m[1].trim() })
  }
  for (let i = 1; i <= 100; i++) {
    const u = content.match(new RegExp(`URL${i}=(.+)`, 'm'))
    const t = content.match(new RegExp(`窗口标题${i}=(.+)`, 'm'))
    const ip = content.match(new RegExp(`控制IP${i}=(.+)`, 'm'))
    if (u && u[1].trim()) config.items.push({ index: i, url: u[1].trim(), title: t ? t[1].trim() : `窗口${i}`, controlIP: ip ? ip[1].trim() : '' })
  }
  return config
}

// ========== 设置第二层窗口标题 ==========
function setLayer2Title (win, item, retryCount = 0) {
  try {
    const hwndBuf = win.getNativeWindowHandle()
    let hwndHex
    if (hwndBuf.length === 8) { const lo = hwndBuf.readUInt32LE(0), hi = hwndBuf.readUInt32LE(4); hwndHex = hi === 0 ? lo.toString(16).toUpperCase() : hwndBuf.readBigUInt64LE().toString(16).toUpperCase() }
    else { hwndHex = hwndBuf.readUInt32LE(0).toString(16).toUpperCase() }
    const childTitle = `${item.index}|${item.controlIP}`
    const psScript = `Add-Type -TypeDefinition @"\nusing System;using System.Runtime.InteropServices;\npublic class W{[DllImport("user32.dll")]public static extern IntPtr FindWindowEx(IntPtr p,IntPtr c,string n,string t);\n[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern bool SetWindowText(IntPtr h,string s);\n[DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr h,uint c);}\n"@\n$p=[IntPtr]0x${hwndHex};$c=[W]::FindWindowEx($p,[IntPtr]::Zero,"Chrome Legacy Window",$null)\nif($c -eq [IntPtr]::Zero){$c=[W]::GetWindow($p,5)}\nif($c -ne [IntPtr]::Zero){[W]::SetWindowText($c,"${childTitle}");Write-Host "OK"}else{Write-Host "RETRY"}\n`
    const tmpFile = path.join(app.getPath('temp'), `novnc_title_${item.index}.ps1`)
    fs.writeFileSync(tmpFile, psScript, 'utf-8')
    execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive', '-File', tmpFile], { timeout: 8000 }, (err, stdout) => {
      try { fs.unlinkSync(tmpFile) } catch (e) {}
      if ((stdout || '').trim() === 'RETRY' && retryCount < 15) setTimeout(() => setLayer2Title(win, item, retryCount + 1), 600)
    })
  } catch (e) { if (retryCount < 15) setTimeout(() => setLayer2Title(win, item, retryCount + 1), 600) }
}

// ========== 选组界面 ==========
function showGroupSelector (config) {
  selectWindow = new BrowserWindow({ width: 520, height: 120 + config.groups.length * 70, frame: true, title: 'NoVNC 群控 - 选择分组', resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  selectWindow.setMenu(null)
  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;padding:20px}h2{text-align:center;margin-bottom:18px;color:#e94560;font-size:18px}.group-btn{display:block;width:100%;padding:14px;margin-bottom:12px;font-size:16px;font-weight:bold;color:#fff;background:#16213e;border:2px solid #e94560;border-radius:8px;cursor:pointer}.group-btn:hover{background:#e94560}</style></head><body><h2>选择要启动的分组</h2>`
  config.groups.forEach((g) => { const s = (g.index - 1) * 5 + 1, e = g.index * 5; html += `<button class="group-btn" onclick="selectGroup(${g.index})">控制 ${g.name} 组（编号 ${s}-${e}）</button>\n` })
  html += `<script>const{ipcRenderer}=require('electron');function selectGroup(i){ipcRenderer.send('select-group',i)}</script></body></html>`
  selectWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ========== 右下角控制按钮 ==========
function createControlButtons (parentWin) {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  exitWindow = new BrowserWindow({ x: workArea.width - 130, y: workArea.height - 40, width: 120, height: 30, frame: false, transparent: true, parent: parentWin, alwaysOnTop: false, skipTaskbar: true, resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  exitWindow.setMenu(null)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:transparent;width:120px;height:30px;display:flex;gap:2px}button{width:59px;height:30px;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;font-family:"Microsoft YaHei",sans-serif}#syncBtn{background:#28a745}#syncBtn:hover{background:#218838}#syncBtn.active{background:#dc3545}#syncBtn.active:hover{background:#c82333}#exitBtn{background:#e94560}#exitBtn:hover{background:#c23152}</style></head><body><button id="syncBtn" onclick="toggleSync()">同步</button><button id="exitBtn" onclick="quit()">退出</button><script>const{ipcRenderer}=require('electron');let s=false;function toggleSync(){s=!s;const b=document.getElementById('syncBtn');if(s){b.textContent='关闭同步';b.classList.add('active')}else{b.textContent='同步';b.classList.remove('active')}ipcRenderer.send('toggle-sync',s)}function quit(){ipcRenderer.send('exit-app')}</script></body></html>`
  exitWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ========== 主控按钮：在每个VNC窗口内注入/移除 ==========
function injectMasterButtons () {
  vncWindows.forEach((win, i) => {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      (function() {
        // 避免重复注入：已有按钮时显示并更新样式
        var existingBtn = document.getElementById('__novnc_master_btn');
        if (existingBtn) {
          existingBtn.style.display = 'block';
          existingBtn.style.background = ${i} === ${masterWindowIndex} ? '#28a745' : '#555';
          existingBtn.textContent = ${i} === ${masterWindowIndex} ? '主控✓' : '主控';
          return;
        }
        var btn = document.createElement('div');
        btn.id = '__novnc_master_btn';
        btn.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:999999;padding:4px 10px;' +
          'border-radius:4px;color:#fff;font-size:12px;font-weight:bold;font-family:"Microsoft YaHei",sans-serif;' +
          'cursor:pointer;user-select:none;opacity:0.85;transition:opacity 0.2s;' +
          'background:' + (${i} === ${masterWindowIndex} ? "'#28a745'" : "'#555'") + ';';
        btn.textContent = ${i} === ${masterWindowIndex} ? '主控✓' : '主控';
        btn.addEventListener('mouseenter', function(){ btn.style.opacity = '1'; });
        btn.addEventListener('mouseleave', function(){ btn.style.opacity = '0.85'; });
        // 点击切换主控，阻止事件冒泡到 #screen 的同步捕获
        btn.addEventListener('mousedown', function(e){ e.stopPropagation(); e.preventDefault(); }, true);
        btn.addEventListener('mouseup', function(e){ e.stopPropagation(); }, true);
        btn.addEventListener('click', function(e){
          e.stopPropagation();
          e.preventDefault();
          try {
            fetch('http://127.0.0.1:${38980 + currentGroupIndex}/set-master', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ windowIndex: ${i} })
            }).catch(function(){});
          } catch(ex) {}
        }, true);
        document.body.appendChild(btn);
      })()
    `).catch(() => {})
  })
}

function removeMasterButtons () {
  vncWindows.forEach((win) => {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      var btn = document.getElementById('__novnc_master_btn');
      if (btn) btn.style.display = 'none';
    `).catch(() => {})
  })
}

function updateMasterButtons () {
  vncWindows.forEach((win, i) => {
    if (!win || win.isDestroyed()) return
    const isMaster = i === masterWindowIndex
    win.webContents.executeJavaScript(`
      var btn = document.getElementById('__novnc_master_btn');
      if (btn) {
        btn.style.background = ${isMaster} ? '#28a745' : '#555';
        btn.textContent = ${isMaster} ? '主控✓' : '主控';
      }
    `).catch(() => {})
  })
}

// ========== 刷新 canvas 信息缓存 ==========
function refreshCanvasInfo (win, idx) {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(`
    (function() {
      var s = document.getElementById('screen');
      if (!s) return null;
      var c = s.querySelector('canvas');
      if (!c || c.width === 0 || c.height === 0) return null;
      var rect = c.getBoundingClientRect();
      return {
        width: c.width,
        height: c.height,
        rectLeft: rect.left,
        rectTop: rect.top,
        rectWidth: rect.width,
        rectHeight: rect.height,
        scaleX: c.width / rect.width,
        scaleY: c.height / rect.height
      };
    })()
  `).then(info => {
    if (info) canvasInfoCache[idx] = info
  }).catch(() => {})
}

// ========== VNC坐标 → 目标窗口viewport坐标 ==========
function vncToViewport (vncX, vncY, targetIdx) {
  const info = canvasInfoCache[targetIdx]
  if (!info) return null
  return {
    x: Math.round(vncX / info.scaleX + info.rectLeft),
    y: Math.round(vncY / info.scaleY + info.rectTop)
  }
}

// ★★★ 同步核心逻辑 v7 — sendInputEvent + 主控切换 ★★★
//
// 只有主控窗口 (masterWindowIndex) 的输入会同步到其他窗口
// 其他窗口可以正常单独操作，不会影响别的窗口

// ========== 同步：转发鼠标事件到其他窗口 ==========
function forwardMouseEvent (sourceIdx, data) {
  if (!syncEnabled) return
  // ★ 只转发主控窗口的事件
  if (sourceIdx !== masterWindowIndex) return

  const { eventType, x: vncX, y: vncY, button } = data

  vncWindows.forEach((win, i) => {
    if (i === sourceIdx || !win || win.isDestroyed()) return
    if (!canvasInfoCache[i]) refreshCanvasInfo(win, i)
    const vp = vncToViewport(vncX, vncY, i)
    if (!vp) return

    if (eventType === 'mousedown') {
      const btnName = button === 1 ? 'middle' : button === 2 ? 'right' : 'left'
      win.webContents.sendInputEvent({ type: 'mouseDown', x: vp.x, y: vp.y, button: btnName, clickCount: 1 })
    } else if (eventType === 'mouseup') {
      const btnName = button === 1 ? 'middle' : button === 2 ? 'right' : 'left'
      win.webContents.sendInputEvent({ type: 'mouseUp', x: vp.x, y: vp.y, button: btnName, clickCount: 1 })
    } else if (eventType === 'mousemove') {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: vp.x, y: vp.y })
    }
  })
}

// ========== 同步：转发键盘事件到其他窗口 ==========
function forwardKeyEvent (sourceIdx, data) {
  if (!syncEnabled) return
  if (sourceIdx !== masterWindowIndex) return

  vncWindows.forEach((win, i) => {
    if (i === sourceIdx || !win || win.isDestroyed()) return
    if (data.eventType === 'keydown') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: data.key, code: data.code })
    } else if (data.eventType === 'keyup') {
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: data.key, code: data.code })
    }
  })
}

// ========== 同步：转发滚轮事件到其他窗口 ==========
function forwardWheelEvent (sourceIdx, data) {
  if (!syncEnabled) return
  if (sourceIdx !== masterWindowIndex) return

  vncWindows.forEach((win, i) => {
    if (i === sourceIdx || !win || win.isDestroyed()) return
    const vp = vncToViewport(data.x, data.y, i)
    if (!vp) return
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: vp.x, y: vp.y,
      deltaX: -data.deltaX,   // 反转滚轮方向，匹配主控窗口
      deltaY: -data.deltaY,   // 反转滚轮方向，匹配主控窗口
      canScroll: true
    })
  })
}

// ========== HTTP API 服务 ==========
function startAPIServer (groupIndex) {
  const port = 38980 + groupIndex
  currentGroupIndex = groupIndex
  if (apiServer) { try { apiServer.close() } catch (e) {} apiServer = null }

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

    // ★ 设置主控窗口
    if (req.method === 'POST' && req.url === '/set-master') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const newMaster = data.windowIndex
          if (newMaster >= 0 && newMaster < vncWindows.length) {
            masterWindowIndex = newMaster
            updateMasterButtons()
            console.log(`Master window changed to: ${masterWindowIndex}`)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end('{"ok":false}')
        }
      })
      return
    }

    // ★ 同步事件接收
    if (req.method === 'POST' && req.url === '/sync') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const si = data.sourceIndex !== undefined ? data.sourceIndex : -1
          if (si >= 0) {
            if (data.type === 'sync-mouse') forwardMouseEvent(si, data)
            else if (data.type === 'sync-key') forwardKeyEvent(si, data)
            else if (data.type === 'sync-wheel') forwardWheelEvent(si, data)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end('{"ok":false}')
        }
      })
      return
    }

    // ★ 外部控制命令
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const result = handleControlCommand(JSON.parse(body))
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ success: true, message: result }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ success: false, error: e.message }))
        }
      })
      return
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ success: true, windowCount: vncWindows.length, sync: syncEnabled, master: masterWindowIndex, port }))
      return
    }
    res.writeHead(404); res.end('Not Found')
  })
  server.listen(port, '127.0.0.1', () => console.log(`API + Sync on http://127.0.0.1:${port}`))
  apiServer = server
}

// ========== HTTP API: 外部控制命令 ==========
function handleControlCommand (data) {
  const { action } = data
  if (action.endsWith('All')) {
    let count = 0
    vncWindows.forEach((w, i) => { if (w && !w.isDestroyed()) { sendToVNC(i, data); count++ } })
    return `Sent to ${count} windows`
  }
  const idx = data.windowIndex || 0
  const win = vncWindows[idx]
  if (!win || win.isDestroyed()) throw new Error(`Window ${idx} not found`)
  sendToVNC(idx, data)
  return `Sent to window ${idx}`
}

function sendToVNC (winIdx, data) {
  const win = vncWindows[winIdx]
  if (!win || win.isDestroyed()) return
  const info = canvasInfoCache[winIdx]
  const { action, x, y, deltaY, deltaX, text, code, down } = data

  if (action === 'clipboard' || action === 'clipboardAll') {
    win.webContents.executeJavaScript(`
      (function(){
        var r = window.__rfb;
        if(r && r.clipboardPasteFrom) { r.clipboardPasteFrom(${JSON.stringify(text || '')}); return; }
      })()
    `).catch(() => {})
    return
  }

  if (action === 'keypress' || action === 'keypressAll') {
    const isDown = down !== false
    win.webContents.sendInputEvent({ type: isDown ? 'keyDown' : 'keyUp', keyCode: code || '', code: code || '' })
    return
  }

  if (!info) { refreshCanvasInfo(win, winIdx); return }
  const vx = Math.round((x || 0) / info.scaleX + info.rectLeft)
  const vy = Math.round((y || 0) / info.scaleY + info.rectTop)

  if (action === 'click' || action === 'clickAll') {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: vx, y: vy, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: vx, y: vy, button: 'left', clickCount: 1 })
  } else if (action === 'mousedown' || action === 'mousedownAll') {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: vx, y: vy, button: 'left', clickCount: 1 })
  } else if (action === 'mouseup' || action === 'mouseupAll') {
    win.webContents.sendInputEvent({ type: 'mouseUp', x: vx, y: vy, button: 'left', clickCount: 1 })
  } else if (action === 'mousemove' || action === 'mousemoveAll') {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: vx, y: vy })
  } else if (action === 'rightclick' || action === 'rightclickAll') {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: vx, y: vy, button: 'right', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: vx, y: vy, button: 'right', clickCount: 1 })
  } else if (action === 'scroll' || action === 'scrollAll') {
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: vx, y: vy, deltaX: deltaX || 0, deltaY: deltaY || 0, canScroll: true })
  }
}

// ========== 创建VNC窗口 ==========
function createVNCWindows (config, groupIndex) {
  if (selectWindow) { selectWindow.close(); selectWindow = null }
  const startIdx = (groupIndex - 1) * 5
  const groupItems = config.items.slice(startIdx, startIdx + 5)
  if (groupItems.length === 0) return

  const workArea = screen.getPrimaryDisplay().workAreaSize
  const winW = 853, winH = 500
  const cols = Math.min(groupItems.length, Math.floor(workArea.width / winW))
  const rows = Math.ceil(groupItems.length / cols)
  const offsetX = Math.floor((workArea.width - cols * winW) / 2)
  const apiPort = 38980 + groupIndex

  groupItems.forEach((item, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const x = offsetX + col * winW, y = row * winH

    const win = new BrowserWindow({
      x, y, width: winW, height: winH,
      frame: false, transparent: true, title: item.title,
      useContentSize: true, show: true, backgroundColor: '#000000',
      webPreferences: {
        webgl: true, hardwareAcceleration: true, offscreen: false,
        backgroundThrottling: false,
        nodeIntegration: false, contextIsolation: true
      }
    })

    win.setMenu(null)
    win.on('page-title-updated', (event) => { event.preventDefault(); win.setTitle(item.title) })

    // ★ 键盘同步捕获
    win.webContents.on('before-input-event', (event, input) => {
      if (!syncEnabled) return
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return
      const si = vncWindows.indexOf(win)
      if (si === -1) return
      forwardKeyEvent(si, {
        type: 'sync-key',
        eventType: input.type === 'keyDown' ? 'keydown' : 'keyup',
        key: input.key,
        code: input.code
      })
    })

    win.webContents.on('did-finish-load', () => {
      setTimeout(() => setLayer2Title(win, item), 500)

      // ★ 刷新 canvas 信息缓存
      refreshCanvasInfo(win, i)
      setTimeout(() => refreshCanvasInfo(win, i), 2000)
      setTimeout(() => refreshCanvasInfo(win, i), 5000)

      // ★ 注入同步事件捕获代码
      win.webContents.executeJavaScript(`
        (function() {
          var screen = document.getElementById('screen');
          if (!screen) return;
          var API_URL = 'http://127.0.0.1:${apiPort}/sync';
          var WIN_IDX = ${i};

          function sendSync(data) {
            data.sourceIndex = WIN_IDX;
            try {
              fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              }).catch(function(){});
            } catch(e) {}
          }

          // 鼠标事件：capture 阶段监听 #screen
          ['mousedown', 'mouseup', 'mousemove'].forEach(function(et) {
            screen.addEventListener(et, function(e) {
              var canvas = screen.querySelector('canvas');
              if (!canvas) return;
              var rect = canvas.getBoundingClientRect();
              var scaleX = canvas.width / rect.width;
              var scaleY = canvas.height / rect.height;
              var realX = Math.round((e.clientX - rect.left) * scaleX);
              var realY = Math.round((e.clientY - rect.top) * scaleY);
              sendSync({
                type: 'sync-mouse',
                eventType: et,
                x: realX,
                y: realY,
                buttons: e.buttons,
                button: e.button
              });
            }, true);
          });

          // 右键菜单拦截 — 只阻止浏览器右键菜单，不同步事件
          // 右键的mousedown/mouseup已经被上面的事件监听捕获了，这里再发会导致右键重复
          screen.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            e.stopPropagation();
          }, true);

          // 滚轮事件
          document.addEventListener('wheel', function(e) {
            var canvas = screen.querySelector('canvas');
            if (!canvas) return;
            var rect = canvas.getBoundingClientRect();
            var scaleX = canvas.width / rect.width;
            var scaleY = canvas.height / rect.height;
            var realX = Math.round((e.clientX - rect.left) * scaleX);
            var realY = Math.round((e.clientY - rect.top) * scaleY);
            sendSync({ type: 'sync-wheel', deltaY: e.deltaY, deltaX: e.deltaX, x: realX, y: realY });
          }, true);

          console.log('[novnc-sync] capture v7 (sendInputEvent + master) injected, window=' + WIN_IDX);
        })()
      `).catch(() => {})
    })

    win.on('resize', () => refreshCanvasInfo(win, i))
    win.loadURL(item.url)
    vncWindows.push(win)
  })

  createControlButtons(vncWindows[0] || null)
  if (!apiServer) startAPIServer(groupIndex)
}

// ========== 主流程 ==========
app.whenReady().then(() => {
  const config = readConfig()
  if (!config) { require('electron').dialog.showErrorBox('读取配置文件异常', '未找到配置文件！'); app.quit(); return }
  if (config.groups.length === 0) { require('electron').dialog.showErrorBox('配置异常', '未找到分组信息！'); app.quit(); return }
  if (config.groups.length === 1) createVNCWindows(config, config.groups[0].index)
  else showGroupSelector(config)
  app.on('activate', () => {})
})

ipcMain.on('select-group', (event, groupIndex) => { createVNCWindows(readConfig(), groupIndex) })
ipcMain.on('toggle-sync', (event, enabled) => {
  syncEnabled = enabled
  if (enabled) {
    // ★ 不重置masterWindowIndex，保留上次用户选择的主控窗口
    vncWindows.forEach((w, i) => refreshCanvasInfo(w, i))
    // ★ 同步开启时，注入/更新主控按钮（确保显示与实际一致）
    setTimeout(() => {
      injectMasterButtons()
      updateMasterButtons()
    }, 300)
  } else {
    // ★ 同步关闭时，移除主控按钮
    removeMasterButtons()
  }
  console.log(`Sync ${enabled ? 'ON' : 'OFF'}, master=${masterWindowIndex}`)
})
ipcMain.on('exit-app', () => {
  vncWindows.forEach(w => { try { w.destroy() } catch (e) {} }); vncWindows.length = 0
  if (exitWindow) { try { exitWindow.destroy() } catch (e) {} exitWindow = null }
  if (apiServer) { try { apiServer.close() } catch (e) {} apiServer = null }
  app.quit(); process.exit(0)
})
app.on('window-all-closed', () => {})
