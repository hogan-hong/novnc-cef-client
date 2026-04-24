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

// ========== 右下角按钮 ==========
function createControlButtons (parentWin) {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  exitWindow = new BrowserWindow({ x: workArea.width - 130, y: workArea.height - 40, width: 120, height: 30, frame: false, transparent: true, parent: parentWin, alwaysOnTop: false, skipTaskbar: true, resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  exitWindow.setMenu(null)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:transparent;width:120px;height:30px;display:flex;gap:2px}button{width:59px;height:30px;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;font-family:"Microsoft YaHei",sans-serif}#syncBtn{background:#28a745}#syncBtn:hover{background:#218838}#syncBtn.active{background:#dc3545}#syncBtn.active:hover{background:#c82333}#exitBtn{background:#e94560}#exitBtn:hover{background:#c23152}</style></head><body><button id="syncBtn" onclick="toggleSync()">同步</button><button id="exitBtn" onclick="quit()">退出</button><script>const{ipcRenderer}=require('electron');let s=false;function toggleSync(){s=!s;const b=document.getElementById('syncBtn');if(s){b.textContent='关闭同步';b.classList.add('active')}else{b.textContent='同步';b.classList.remove('active')}ipcRenderer.send('toggle-sync',s)}function quit(){ipcRenderer.send('exit-app')}</script></body></html>`
  exitWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ★★★ 同步核心逻辑 ★★★
//
// 之前4版同步都失败的根本原因：
// 1. vnc_lite.html 所有同步代码都在 if(window.parent && window.parent!==window) 里
//    Electron独立窗口中 window.parent === window，所以这些代码不执行
//    包括 sync-mouse-event 的接收器也不执行
// 2. rfb 是 ES module 的 let 变量，executeJavaScript 访问不到 window.rfb
//
// 正确方案：
// - 发送端：在 #screen 上监听鼠标事件（#screen 在页面加载时就存在），通过 fetch 发到 /sync API
// - 接收端：直接向 canvas dispatch MouseEvent/KeyboardEvent
//   RFB 在 canvas 上注册了 mousedown/mouseup/mousemove 事件监听器
//   dispatch MouseEvent 到 canvas → RFB._handleMouse 自动处理 → 发送 VNC 协议消息
// - 键盘：Electron before-input-event 捕获，接收端 dispatch KeyboardEvent 到 canvas

function forwardSyncEvent (sourceWinIndex, data) {
  if (!syncEnabled) return
  vncWindows.forEach((win, i) => {
    if (i === sourceWinIndex || !win || win.isDestroyed()) return

    if (data.type === 'sync-mouse') {
      // ★ 接收端：向 canvas dispatch MouseEvent
      // RFB._handleMouse 从 MouseEvent 的 clientX/clientY 提取坐标
      // 我们需要把 VNC 设备坐标转回 CSS 坐标（clientX/clientY）
      const { eventType, x, y, buttons } = data
      win.webContents.executeJavaScript(`
        (function(){
          var s=document.getElementById('screen');
          if(!s)return;
          var c=s.querySelector('canvas');
          if(!c)return;
          var r=c.getBoundingClientRect();
          // VNC设备坐标 → CSS坐标：设备坐标 / scale = CSS偏移，加上 rect.left/top = clientX/clientY
          var scaleX=c.width/r.width;
          var scaleY=c.height/r.height;
          var cx=r.left+${x}/scaleX;
          var cy=r.top+${y}/scaleY;
          var et='${eventType}';
          // mousedown/mouseup 用 button 位掩码确定哪个键
          // MouseEvent.button: 0=左键, 1=中键, 2=右键
          var btn=0;
          if(${buttons}&1)btn=0;
          else if(${buttons}&2)btn=2;
          else if(${buttons}&4)btn=1;
          if(et==='mousedown'||et==='mouseup'||et==='mousemove'){
            var me=new MouseEvent(et,{clientX:cx,clientY:cy,button:btn,buttons:${buttons},bubbles:true,cancelable:true});
            c.dispatchEvent(me);
          }
        })()
      `).catch(() => {})
    } else if (data.type === 'sync-key') {
      // ★ 键盘：dispatch KeyboardEvent 到 canvas
      // RFB._keyboard 在 canvas 上监听 keydown/keyup
      win.webContents.executeJavaScript(`
        (function(){
          var s=document.getElementById('screen');
          if(!s)return;
          var c=s.querySelector('canvas');
          if(!c)return;
          var ke=new KeyboardEvent('${data.eventType}',{code:'${data.code}',key:'${data.key || ''}',keyCode:${data.keyCode || 0},which:${data.keyCode || 0},bubbles:true,cancelable:true});
          c.dispatchEvent(ke);
        })()
      `).catch(() => {})
    } else if (data.type === 'sync-wheel') {
      // ★ 滚轮：dispatch WheelEvent 到 canvas
      win.webContents.executeJavaScript(`
        (function(){
          var s=document.getElementById('screen');
          if(!s)return;
          var c=s.querySelector('canvas');
          if(!c)return;
          var r=c.getBoundingClientRect();
          var scaleX=c.width/r.width;
          var scaleY=c.height/r.height;
          var cx=r.left+${data.x}/scaleX;
          var cy=r.top+${data.y}/scaleY;
          var we=new WheelEvent('wheel',{deltaY:${data.deltaY},deltaX:${data.deltaX},clientX:cx,clientY:cy,bubbles:true,cancelable:true});
          c.dispatchEvent(we);
        })()
      `).catch(() => {})
    }
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

    // /sync 端点
    if (req.method === 'POST' && req.url === '/sync') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const si = data.sourceIndex !== undefined ? data.sourceIndex : -1
          if (si >= 0) forwardSyncEvent(si, data)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end('{"ok":false}')
        }
      })
      return
    }

    // 外部API控制端点
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
      res.end(JSON.stringify({ success: true, windowCount: vncWindows.length, sync: syncEnabled, port }))
      return
    }
    res.writeHead(404); res.end('Not Found')
  })
  server.listen(port, '127.0.0.1', () => console.log(`API + Sync on http://127.0.0.1:${port}`))
  apiServer = server
}

function handleControlCommand (data) {
  const { action } = data
  if (action.endsWith('All')) {
    let count = 0
    vncWindows.forEach(w => { if (w && !w.isDestroyed()) { sendToVNC(w, data); count++ } })
    return `Sent to ${count} windows`
  }
  const idx = data.windowIndex || 0
  const win = vncWindows[idx]
  if (!win || win.isDestroyed()) throw new Error(`Window ${idx} not found`)
  sendToVNC(win, data)
  return `Sent to window ${idx}`
}

// ★ 外部API控制也改用 dispatchEvent 方式（不再依赖 postMessage）
function sendToVNC (win, data) {
  const { action, x, y, keysym, code, down, deltaY, deltaX, text, buttons } = data

  if (action === 'clipboard' || action === 'clipboardAll') {
    // 剪贴板：需要 rfb.clipboardPasteFrom，但 rfb 不可访问
    // 用 document.execCommand('insertText') 或 input 事件代替
    // 实际上最简单的方式还是用 postMessage，因为 clipboard 不依赖那个 if 块
    win.webContents.executeJavaScript(`(function(){try{var s=document.getElementById('screen');var rfb=s.__rfb;if(!rfb){var c=s.querySelector('canvas');if(c)rfb=c.__rfb}if(rfb&&rfb.clipboardPasteFrom)rfb.clipboardPasteFrom(${JSON.stringify(text || '')})}catch(e){}})()`).catch(() => {})
    return
  }

  if (action === 'keypress' || action === 'keypressAll') {
    win.webContents.executeJavaScript(`
      (function(){
        var s=document.getElementById('screen');if(!s)return;
        var c=s.querySelector('canvas');if(!c)return;
        var ke=new KeyboardEvent('${down ? 'keydown' : 'keyup'}',{code:'${code || ''}',bubbles:true,cancelable:true});
        c.dispatchEvent(ke);
      })()
    `).catch(() => {})
    return
  }

  // 鼠标/滚轮：先做坐标缩放，然后 dispatchEvent
  win.webContents.executeJavaScript(`
    (function(){
      var s=document.getElementById('screen');
      if(!s)return;
      var c=s.querySelector('canvas');
      if(!c)return;
      var r=c.getBoundingClientRect();
      var sx=c.width/r.width;
      var sy=c.height/r.height;
      var rx=${x || 0}; var ry=${y || 0};
      var cx=r.left+rx/sx;
      var cy=r.top+ry/sy;
      var a='${action}';
      if(a==='click'||a==='clickAll'){
        var me1=new MouseEvent('mousedown',{clientX:cx,clientY:cy,button:0,buttons:1,bubbles:true,cancelable:true});
        c.dispatchEvent(me1);
        var me2=new MouseEvent('mouseup',{clientX:cx,clientY:cy,button:0,buttons:0,bubbles:true,cancelable:true});
        c.dispatchEvent(me2);
      }else if(a==='mousedown'||a==='mousedownAll'){
        var me=new MouseEvent('mousedown',{clientX:cx,clientY:cy,button:0,buttons:1,bubbles:true,cancelable:true});
        c.dispatchEvent(me);
      }else if(a==='mouseup'||a==='mouseupAll'){
        var me=new MouseEvent('mouseup',{clientX:cx,clientY:cy,button:0,buttons:0,bubbles:true,cancelable:true});
        c.dispatchEvent(me);
      }else if(a==='mousemove'||a==='mousemoveAll'){
        var me=new MouseEvent('mousemove',{clientX:cx,clientY:cy,buttons:${buttons || 0},bubbles:true,cancelable:true});
        c.dispatchEvent(me);
      }else if(a==='scroll'||a==='scrollAll'){
        var we=new WheelEvent('wheel',{deltaY:${deltaY || 0},deltaX:${deltaX || 0},clientX:cx,clientY:cy,bubbles:true,cancelable:true});
        c.dispatchEvent(we);
      }
    })()
  `).catch(() => {})
}

// ========== 创建VNC窗口 ==========
function createVNCWindows (config, groupIndex) {
  if (selectWindow) { selectWindow.close(); selectWindow = null }
  const startIdx = (groupIndex - 1) * 5
  const groupItems = config.items.slice(startIdx, startIdx + 5)
  if (groupItems.length === 0) return

  const workArea = screen.getPrimaryDisplay().workAreaSize
  const winW = 853, winH = 520
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

    // ★ 键盘同步：Electron原生 before-input-event
    win.webContents.on('before-input-event', (event, input) => {
      if (!syncEnabled) return
      if (input.type === 'keyDown' || input.type === 'keyUp') {
        const si = vncWindows.indexOf(win)
        if (si === -1) return
        forwardSyncEvent(si, {
          type: 'sync-key',
          eventType: input.type === 'keyDown' ? 'keydown' : 'keyup',
          keyCode: input.keyCode,
          code: input.code,
          key: input.key
        })
      }
    })

    win.webContents.on('did-finish-load', () => {
      setTimeout(() => setLayer2Title(win, item), 500)

      // ★★★ 同步事件捕获注入 ★★★
      // 在 #screen 上监听鼠标事件（冒泡到 #screen），通过 fetch 发到 /sync API
      // #screen 在页面加载时就存在（是 RFB 构造函数的 target），canvas 是它的子元素
      win.webContents.executeJavaScript(`
        (function() {
          var screen = document.getElementById('screen');
          if (!screen) { console.error('[sync] #screen not found, retrying...'); return; }
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

          // 鼠标事件：监听 #screen（canvas是它的子元素，事件冒泡上来）
          // 使用 capture=true 确保在 RFB 处理之前捕获
          ['mousedown', 'mouseup', 'mousemove', 'contextmenu'].forEach(function(et) {
            screen.addEventListener(et, function(e) {
              var canvas = screen.querySelector('canvas');
              if (!canvas) return;
              var rect = canvas.getBoundingClientRect();
              var scaleX = canvas.width / rect.width;
              var scaleY = canvas.height / rect.height;
              var realX = Math.round((e.clientX - rect.left) * scaleX);
              var realY = Math.round((e.clientY - rect.top) * scaleY);
              if (et === 'contextmenu') { e.preventDefault(); e.stopPropagation(); }
              sendSync({ type: 'sync-mouse', eventType: et, x: realX, y: realY, buttons: e.buttons });
            }, true);
          });

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

          console.log('[novnc-sync] capture injected OK, window=' + WIN_IDX + ' api=' + API_URL);
        })()
      `).catch(() => {})
    })

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
ipcMain.on('toggle-sync', (event, enabled) => { syncEnabled = enabled; console.log(`Sync ${enabled ? 'ON' : 'OFF'}`) })
ipcMain.on('exit-app', () => {
  vncWindows.forEach(w => { try { w.destroy() } catch (e) {} }); vncWindows.length = 0
  if (exitWindow) { try { exitWindow.destroy() } catch (e) {} exitWindow = null }
  if (apiServer) { try { apiServer.close() } catch (e) {} apiServer = null }
  app.quit(); process.exit(0)
})
app.on('window-all-closed', () => {})
