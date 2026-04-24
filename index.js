const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const http = require('http')

// ========== 禁用 DirectComposition，保证GDI截图不黑屏 ==========
app.commandLine.appendSwitch('disable-direct-composition')
app.commandLine.appendSwitch('no-sandbox')

// ========== GPU 加速 ==========
app.commandLine.appendSwitch('enable-gpu')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

// ========== 禁用后台节流 ==========
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

// ========== 读取配置文件 ==========
function readConfig () {
  const searchPaths = [
    path.join(path.dirname(app.getPath('exe')), '配置文件.int'),
    path.join(process.cwd(), '配置文件.int'),
    path.join(app.getAppPath(), '配置文件.int')
  ]

  let configPath = null
  for (const p of searchPaths) {
    if (fs.existsSync(p)) { configPath = p; break }
  }
  if (!configPath) return null

  const iconv = require('iconv-lite')
  const rawBuf = fs.readFileSync(configPath)
  const content = iconv.decode(rawBuf, 'gbk')

  const config = { groups: [], items: [] }

  for (let i = 1; i <= 10; i++) {
    const match = content.match(new RegExp(`组${i}名称=(.+)`, 'm'))
    if (match && match[1].trim()) config.groups.push({ index: i, name: match[1].trim() })
  }

  for (let i = 1; i <= 100; i++) {
    const urlMatch = content.match(new RegExp(`URL${i}=(.+)`, 'm'))
    const titleMatch = content.match(new RegExp(`窗口标题${i}=(.+)`, 'm'))
    const ipMatch = content.match(new RegExp(`控制IP${i}=(.+)`, 'm'))
    if (urlMatch && urlMatch[1].trim()) {
      config.items.push({
        index: i, url: urlMatch[1].trim(),
        title: titleMatch ? titleMatch[1].trim() : `窗口${i}`,
        controlIP: ipMatch ? ipMatch[1].trim() : ''
      })
    }
  }
  return config
}

// ========== 设置第二层窗口标题 ==========
function setLayer2Title (win, item, retryCount = 0) {
  try {
    const hwndBuf = win.getNativeWindowHandle()
    let hwndHex
    if (hwndBuf.length === 8) {
      const lo = hwndBuf.readUInt32LE(0), hi = hwndBuf.readUInt32LE(4)
      hwndHex = hi === 0 ? lo.toString(16).toUpperCase() : hwndBuf.readBigUInt64LE().toString(16).toUpperCase()
    } else {
      hwndHex = hwndBuf.readUInt32LE(0).toString(16).toUpperCase()
    }
    const childTitle = `${item.index}|${item.controlIP}`
    const psScript = `
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern IntPtr FindWindowEx(IntPtr p,IntPtr c,string n,string t);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern bool SetWindowText(IntPtr h,string s);
[DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr h,uint c);}
"@
$p=[IntPtr]0x${hwndHex};$c=[W]::FindWindowEx($p,[IntPtr]::Zero,"Chrome Legacy Window",$null)
if($c -eq [IntPtr]::Zero){$c=[W]::GetWindow($p,5)}
if($c -ne [IntPtr]::Zero){[W]::SetWindowText($c,"${childTitle}");Write-Host "OK"}else{Write-Host "RETRY"}
`
    const tmpFile = path.join(app.getPath('temp'), `novnc_title_${item.index}.ps1`)
    fs.writeFileSync(tmpFile, psScript, 'utf-8')
    execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive', '-File', tmpFile], { timeout: 8000 }, (err, stdout) => {
      try { fs.unlinkSync(tmpFile) } catch (e) {}
      if ((stdout || '').trim() === 'RETRY' && retryCount < 15) setTimeout(() => setLayer2Title(win, item, retryCount + 1), 600)
    })
  } catch (e) {
    if (retryCount < 15) setTimeout(() => setLayer2Title(win, item, retryCount + 1), 600)
  }
}

// ========== 选组界面 ==========
let selectWindow = null
function showGroupSelector (config) {
  selectWindow = new BrowserWindow({ width: 520, height: 120 + config.groups.length * 70, frame: true, title: 'NoVNC 群控 - 选择分组', resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  selectWindow.setMenu(null)
  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;padding:20px}h2{text-align:center;margin-bottom:18px;color:#e94560;font-size:18px}.group-btn{display:block;width:100%;padding:14px;margin-bottom:12px;font-size:16px;font-weight:bold;color:#fff;background:#16213e;border:2px solid #e94560;border-radius:8px;cursor:pointer}.group-btn:hover{background:#e94560}</style></head><body><h2>选择要启动的分组</h2>`
  config.groups.forEach((g) => {
    const s = (g.index - 1) * 5 + 1, e = g.index * 5
    html += `<button class="group-btn" onclick="selectGroup(${g.index})">控制 ${g.name} 组（编号 ${s}-${e}）</button>\n`
  })
  html += `<script>const{ipcRenderer}=require('electron');function selectGroup(i){ipcRenderer.send('select-group',i)}</script></body></html>`
  selectWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ========== 右下角按钮（同步+退出） ==========
let exitWindow = null
let syncEnabled = false

function createControlButtons (parentWin) {
  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workAreaSize
  exitWindow = new BrowserWindow({ x: workArea.width - 130, y: workArea.height - 40, width: 120, height: 30, frame: false, transparent: true, parent: parentWin, alwaysOnTop: false, skipTaskbar: true, resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  exitWindow.setMenu(null)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:transparent;width:120px;height:30px;display:flex;gap:2px}button{width:59px;height:30px;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;font-family:"Microsoft YaHei",sans-serif}#syncBtn{background:#28a745}#syncBtn:hover{background:#218838}#syncBtn.active{background:#dc3545}#syncBtn.active:hover{background:#c82333}#exitBtn{background:#e94560}#exitBtn:hover{background:#c23152}</style></head><body><button id="syncBtn" onclick="toggleSync()">同步</button><button id="exitBtn" onclick="quit()">退出</button><script>const{ipcRenderer}=require('electron');let syncOn=false;function toggleSync(){syncOn=!syncOn;const b=document.getElementById('syncBtn');if(syncOn){b.textContent='关闭同步';b.classList.add('active')}else{b.textContent='同步';b.classList.remove('active')}ipcRenderer.send('toggle-sync',syncOn)}function quit(){ipcRenderer.send('exit-app')}</script></body></html>`
  exitWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ========== VNC窗口管理 ==========
const vncWindows = []

// ========== 同步：转发事件到其他窗口 ==========
function forwardSyncEvent (sourceWinIndex, data) {
  if (!syncEnabled) return
  vncWindows.forEach((win, i) => {
    if (i === sourceWinIndex || !win || win.isDestroyed()) return
    if (data.type === 'sync-mouse') {
      win.webContents.executeJavaScript(`window.postMessage({type:'sync-mouse-event',eventType:'${data.eventType}',x:${data.x},y:${data.y},buttons:${data.buttons}},'*')`).catch(() => {})
    } else if (data.type === 'sync-key') {
      win.webContents.executeJavaScript(`(function(){try{var rfb=window.rfb||document.getElementById('screen').__rfb;if(rfb)rfb.sendKey(${data.keyCode},'${data.code}',${data.eventType === 'keydown'})}catch(e){}})()`).catch(() => {})
    } else if (data.type === 'sync-wheel') {
      win.webContents.executeJavaScript(`window.postMessage({type:'sync-wheel-event',deltaY:${data.deltaY},deltaX:${data.deltaX},x:${data.x},y:${data.y}},'*')`).catch(() => {})
    }
  })
}

// ========== HTTP API 服务 ==========
let apiServer = null
function startAPIServer (groupIndex) {
  const port = 38980 + groupIndex
  if (apiServer) { try { apiServer.close() } catch (e) {} apiServer = null }
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }
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
      res.end(JSON.stringify({ success: true, windowCount: vncWindows.length, sync: syncEnabled }))
      return
    }
    res.writeHead(404); res.end('Not Found')
  })
  server.listen(port, '127.0.0.1', () => console.log(`API on http://127.0.0.1:${port}`))
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

function sendToVNC (win, data) {
  const { action, x, y, keysym, code, down, deltaY, deltaX, text, buttons } = data
  if (action === 'keypress' || action === 'keypressAll') {
    win.webContents.executeJavaScript(`window.postMessage({type:'sync-key-event',eventType:'${down ? 'keydown' : 'keyup'}',keysym:${keysym || 0},code:'${code || ''}'},'*')`).catch(() => {})
    return
  }
  if (action === 'clipboard' || action === 'clipboardAll') {
    win.webContents.executeJavaScript(`window.postMessage({type:'sync-clipboard',text:${JSON.stringify(text || '')}},'*')`).catch(() => {})
    return
  }
  win.webContents.executeJavaScript(`
    (function(){var s=document.getElementById('screen');var c=s?s.querySelector('canvas'):null;if(!c)return;
    var r=c.getBoundingClientRect();var sx=c.width/r.width;var sy=c.height/r.height;
    var rx=Math.round((${x||0})*sx);var ry=Math.round((${y||0})*sy);var a='${action}';var b=${buttons||0};var dy=${deltaY||0};var dx=${deltaX||0};
    if(a==='click'||a==='clickAll'){window.postMessage({type:'sync-mouse-event',eventType:'mousedown',x:rx,y:ry,buttons:1},'*');window.postMessage({type:'sync-mouse-event',eventType:'mouseup',x:rx,y:ry,buttons:0},'*')}
    else if(a==='mousedown'||a==='mousedownAll'){window.postMessage({type:'sync-mouse-event',eventType:'mousedown',x:rx,y:ry,buttons:1},'*')}
    else if(a==='mouseup'||a==='mouseupAll'){window.postMessage({type:'sync-mouse-event',eventType:'mouseup',x:rx,y:ry,buttons:0},'*')}
    else if(a==='mousemove'||a==='mousemoveAll'){window.postMessage({type:'sync-mouse-event',eventType:'mousemove',x:rx,y:ry,buttons:b},'*')}
    else if(a==='scroll'||a==='scrollAll'){window.postMessage({type:'sync-wheel-event',deltaY:dy,deltaX:dx,x:rx,y:ry},'*')}})()
  `).catch(() => {})
}

// ========== 创建VNC窗口 ==========
function createVNCWindows (config, groupIndex) {
  if (selectWindow) { selectWindow.close(); selectWindow = null }
  const startIdx = (groupIndex - 1) * 5
  const groupItems = config.items.slice(startIdx, startIdx + 5)
  if (groupItems.length === 0) return

  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workAreaSize
  const winW = 853, winH = 520
  const cols = Math.min(groupItems.length, Math.floor(workArea.width / winW))
  const rows = Math.ceil(groupItems.length / cols)
  const totalWidth = cols * winW
  const offsetX = Math.floor((workArea.width - totalWidth) / 2)

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
        nodeIntegration: true,     // ★ 需要ipcRenderer给同步事件上报
        contextIsolation: false    // ★ 让注入脚本能访问ipcRenderer
      }
    })

    win.setMenu(null)

    // ★ 第一层标题保持
    win.on('page-title-updated', (event) => {
      event.preventDefault()
      win.setTitle(item.title)
    })

    // ★ 键盘同步：用Electron原生 before-input-event 捕获（最可靠）
    win.webContents.on('before-input-event', (event, input) => {
      if (!syncEnabled) return
      if (input.type === 'keyDown' || input.type === 'keyUp') {
        const sourceIndex = vncWindows.indexOf(win)
        if (sourceIndex === -1) return
        forwardSyncEvent(sourceIndex, {
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

      // ★ 鼠标同步：注入事件捕获脚本，通过ipcRenderer上报给主进程
      win.webContents.executeJavaScript(`
        (function() {
          var screen = document.getElementById('screen');
          if (!screen) return;
          try { var ipc = require('electron').ipcRenderer; } catch(e) { return; }

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
              try { ipc.send('vnc-sync-event', { type: 'sync-mouse', eventType: et, x: realX, y: realY, buttons: e.buttons }); } catch(ex) {}
            }, true);
          });

          document.addEventListener('wheel', function(e) {
            var canvas = screen.querySelector('canvas');
            if (!canvas) return;
            var rect = canvas.getBoundingClientRect();
            var scaleX = canvas.width / rect.width;
            var scaleY = canvas.height / rect.height;
            var realX = Math.round((e.clientX - rect.left) * scaleX);
            var realY = Math.round((e.clientY - rect.top) * scaleY);
            try { ipc.send('vnc-sync-event', { type: 'sync-wheel', deltaY: e.deltaY, deltaX: e.deltaX, x: realX, y: realY }); } catch(ex) {}
          }, true);

          console.log('[sync] event capture injected ok');
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

ipcMain.on('toggle-sync', (event, enabled) => {
  syncEnabled = enabled
  console.log(`Sync ${enabled ? 'enabled' : 'disabled'}`)
})

// ★ 接收VNC窗口上报的同步事件（鼠标+滚轮）
ipcMain.on('vnc-sync-event', (event, data) => {
  const sourceIndex = vncWindows.findIndex(w => w && !w.isDestroyed() && w.webContents === event.sender)
  if (sourceIndex === -1) return
  forwardSyncEvent(sourceIndex, data)
})

ipcMain.on('exit-app', () => {
  vncWindows.forEach(w => { try { w.destroy() } catch (e) {} })
  vncWindows.length = 0
  if (exitWindow) { try { exitWindow.destroy() } catch (e) {} exitWindow = null }
  if (apiServer) { try { apiServer.close() } catch (e) {} apiServer = null }
  app.quit(); process.exit(0)
})

app.on('window-all-closed', () => {})
