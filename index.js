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
    if (fs.existsSync(p)) {
      configPath = p
      break
    }
  }

  if (!configPath) return null

  const iconv = require('iconv-lite')
  const rawBuf = fs.readFileSync(configPath)
  const content = iconv.decode(rawBuf, 'gbk')

  const config = { groups: [], items: [] }

  for (let i = 1; i <= 10; i++) {
    const match = content.match(new RegExp(`组${i}名称=(.+)`, 'm'))
    if (match && match[1].trim()) {
      config.groups.push({ index: i, name: match[1].trim() })
    }
  }

  for (let i = 1; i <= 100; i++) {
    const urlMatch = content.match(new RegExp(`URL${i}=(.+)`, 'm'))
    const titleMatch = content.match(new RegExp(`窗口标题${i}=(.+)`, 'm'))
    const ipMatch = content.match(new RegExp(`控制IP${i}=(.+)`, 'm'))

    if (urlMatch && urlMatch[1].trim()) {
      config.items.push({
        index: i,
        url: urlMatch[1].trim(),
        title: titleMatch ? titleMatch[1].trim() : `窗口${i}`,
        controlIP: ipMatch ? ipMatch[1].trim() : ''
      })
    }
  }

  return config
}

// ========== 设置第二层窗口标题（写ps1文件执行） ==========
function setLayer2Title (win, item, retryCount = 0) {
  try {
    const hwndBuf = win.getNativeWindowHandle()
    let hwndHex
    if (hwndBuf.length === 8) {
      const lo = hwndBuf.readUInt32LE(0)
      const hi = hwndBuf.readUInt32LE(4)
      if (hi === 0) {
        hwndHex = lo.toString(16).toUpperCase()
      } else {
        hwndHex = hwndBuf.readBigUInt64LE().toString(16).toUpperCase()
      }
    } else {
      hwndHex = hwndBuf.readUInt32LE(0).toString(16).toUpperCase()
    }

    const childTitle = `${item.index}|${item.controlIP}`

    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string className, string windowTitle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool SetWindowText(IntPtr hWnd, string title);
  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
}
"@

$parent = [IntPtr]0x${hwndHex}
$child = [Win32]::FindWindowEx($parent, [IntPtr]::Zero, "Chrome Legacy Window", $null)

if ($child -eq [IntPtr]::Zero) {
  $child = [Win32]::GetWindow($parent, 5)
}

if ($child -ne [IntPtr]::Zero) {
  [Win32]::SetWindowText($child, "${childTitle}")
  Write-Host "OK"
} else {
  Write-Host "RETRY"
}
`

    const tmpFile = path.join(app.getPath('temp'), `novnc_title_${item.index}.ps1`)
    fs.writeFileSync(tmpFile, psScript, 'utf-8')

    execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive', '-File', tmpFile], { timeout: 8000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile) } catch (e) {}

      const output = (stdout || '').trim()
      if (output === 'RETRY' && retryCount < 15) {
        setTimeout(() => setLayer2Title(win, item, retryCount + 1), 600)
      } else if (output === 'OK') {
        console.log(`Window ${item.index}: layer2 title set to "${childTitle}"`)
      } else {
        if (retryCount < 15) {
          setTimeout(() => setLayer2Title(win, item, retryCount + 1), 600)
        }
      }
    })
  } catch (e) {
    if (retryCount < 15) {
      setTimeout(() => setLayer2Title(win, item, retryCount + 1), 600)
    }
  }
}

// ========== 选组界面 ==========
let selectWindow = null

function showGroupSelector (config) {
  selectWindow = new BrowserWindow({
    width: 520,
    height: 120 + config.groups.length * 70,
    frame: true,
    title: 'NoVNC 群控 - 选择分组',
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  selectWindow.setMenu(null)

  let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
  h2 { text-align: center; margin-bottom: 18px; color: #e94560; font-size: 18px; }
  .group-btn {
    display: block; width: 100%; padding: 14px; margin-bottom: 12px;
    font-size: 16px; font-weight: bold; color: #fff;
    background: #16213e; border: 2px solid #e94560; border-radius: 8px; cursor: pointer;
  }
  .group-btn:hover { background: #e94560; }
</style>
</head>
<body>
<h2>选择要启动的分组</h2>`

  config.groups.forEach((g) => {
    const startIdx = (g.index - 1) * 5 + 1
    const endIdx = g.index * 5
    html += `<button class="group-btn" onclick="selectGroup(${g.index})">控制 ${g.name} 组（编号 ${startIdx}-${endIdx}）</button>\n`
  })

  html += `<script>
    const { ipcRenderer } = require('electron')
    function selectGroup(groupIndex) { ipcRenderer.send('select-group', groupIndex) }
  </script>
</body></html>`

  selectWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ========== 右下角退出按钮 ==========
let exitWindow = null

function createExitButton (parentWin) {
  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workAreaSize

  exitWindow = new BrowserWindow({
    x: workArea.width - 70,
    y: workArea.height - 40,
    width: 60,
    height: 30,
    frame: false,
    transparent: true,
    parent: parentWin,
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  exitWindow.setMenu(null)

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; }
  body { background: transparent; width: 60px; height: 30px; }
  button {
    width: 60px; height: 30px;
    background: #e94560; color: #fff;
    border: none; border-radius: 4px;
    font-size: 12px; font-weight: bold;
    cursor: pointer;
    font-family: "Microsoft YaHei", sans-serif;
  }
  button:hover { background: #c23152; }
</style>
</head>
<body>
<button onclick="quit()">退出</button>
<script>
  const { ipcRenderer } = require('electron')
  function quit() { ipcRenderer.send('exit-app') }
</script>
</body>
</html>`

  exitWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ========== VNC窗口管理 ==========
const vncWindows = []

// ========== HTTP API 服务（接收易语言的控制指令） ==========
let apiServer = null

function startAPIServer (groupIndex) {
  // ★ 端口按组号分配：组1→38981, 组2→38982, 组3→38983
  const port = 38980 + groupIndex

  // 如果已有服务先关闭（切换组时）
  if (apiServer) {
    try { apiServer.close() } catch (e) {}
    apiServer = null
  }

  const server = http.createServer((req, res) => {
    // 允许跨域
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    // POST 请求处理控制指令
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const result = handleControlCommand(data)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ success: true, message: result }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ success: false, error: e.message }))
        }
      })
      return
    }

    // GET 请求返回状态
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        success: true,
        windowCount: vncWindows.length,
        windows: vncWindows.map((w, i) => ({
          index: i,
          title: w.getTitle(),
          visible: w.isVisible()
        }))
      }))
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`NoVNC Control API running on http://127.0.0.1:${port}`)
  })

  apiServer = server
}

// ========== 处理控制指令，转发到lite.html ==========
function handleControlCommand (data) {
  // data 格式:
  // { "action": "click", "windowIndex": 0, "x": 100, "y": 200 }
  // { "action": "mousedown", "windowIndex": 0, "x": 100, "y": 200 }
  // { "action": "mouseup", "windowIndex": 0, "x": 100, "y": 200 }
  // { "action": "mousemove", "windowIndex": 0, "x": 100, "y": 200 }
  // { "action": "keypress", "windowIndex": 0, "keysym": 65, "code": "KeyA", "down": true }
  // { "action": "scroll", "windowIndex": 0, "x": 100, "y": 200, "deltaY": -120 }
  // { "action": "clipboard", "windowIndex": 0, "text": "hello" }
  // { "action": "clickAll", "x": 100, "y": 200 }  -- 所有窗口同时点击
  // { "action": "keypressAll", "keysym": 65, "code": "KeyA", "down": true }  -- 所有窗口同时按键

  const { action } = data

  // ★ 群控操作：所有窗口同时执行
  if (action === 'clickAll' || action === 'keypressAll' || action === 'scrollAll' || action === 'clipboardAll') {
    let count = 0
    vncWindows.forEach((win, i) => {
      if (win && !win.isDestroyed()) {
        sendToVNC(win, data)
        count++
      }
    })
    return `Sent to ${count} windows`
  }

  // ★ 单窗口操作
  const windowIndex = data.windowIndex || 0
  const win = vncWindows[windowIndex]

  if (!win || win.isDestroyed()) {
    throw new Error(`Window index ${windowIndex} not found or destroyed`)
  }

  sendToVNC(win, data)
  return `Sent to window ${windowIndex}`
}

// ========== 发送控制消息到VNC窗口的lite.html ==========
// ★ 所有坐标操作都在浏览器内部做缩放转换（和全部控制E.html一致）
// ★ 大漠传进来的是窗口像素坐标，需要在页面内转成设备实际分辨率坐标
function sendToVNC (win, data) {
  const { action, x, y, keysym, code, down, deltaY, deltaX, text, buttons } = data

  // 键盘和剪贴板不需要坐标转换
  if (action === 'keypress' || action === 'keypressAll') {
    win.webContents.executeJavaScript(`
      window.postMessage(${JSON.stringify({ type: 'sync-key-event', eventType: down ? 'keydown' : 'keyup', keysym, code })}, '*')
    `).catch(() => {})
    return
  }

  if (action === 'clipboard' || action === 'clipboardAll') {
    win.webContents.executeJavaScript(`
      window.postMessage(${JSON.stringify({ type: 'sync-clipboard', text })}, '*')
    `).catch(() => {})
    return
  }

  // ★ 鼠标/滚轮操作：在页面内部做坐标缩放
  // 获取canvas的实际分辨率和显示尺寸，计算缩放比
  const jsCode = `
    (function() {
      var screen = document.getElementById('screen');
      var canvas = screen ? screen.querySelector('canvas') : null;
      if (!canvas) return;
      var rect = canvas.getBoundingClientRect();
      var scaleX = canvas.width / rect.width;
      var scaleY = canvas.height / rect.height;
      var realX = Math.round((${x || 0}) * scaleX);
      var realY = Math.round((${y || 0}) * scaleY);
      var action = '${action}';
      var buttons = ${buttons || 0};
      var deltaY = ${deltaY || 0};
      var deltaX = ${deltaX || 0};

      if (action === 'click' || action === 'clickAll') {
        window.postMessage({type:'sync-mouse-event', eventType:'mousedown', x:realX, y:realY, buttons:1}, '*');
        window.postMessage({type:'sync-mouse-event', eventType:'mouseup', x:realX, y:realY, buttons:0}, '*');
      } else if (action === 'mousedown' || action === 'mousedownAll') {
        window.postMessage({type:'sync-mouse-event', eventType:'mousedown', x:realX, y:realY, buttons:1}, '*');
      } else if (action === 'mouseup' || action === 'mouseupAll') {
        window.postMessage({type:'sync-mouse-event', eventType:'mouseup', x:realX, y:realY, buttons:0}, '*');
      } else if (action === 'mousemove' || action === 'mousemoveAll') {
        window.postMessage({type:'sync-mouse-event', eventType:'mousemove', x:realX, y:realY, buttons:buttons}, '*');
      } else if (action === 'scroll' || action === 'scrollAll') {
        window.postMessage({type:'sync-wheel-event', deltaY:deltaY, deltaX:deltaX, x:realX, y:realY}, '*');
      }
    })()
  `

  win.webContents.executeJavaScript(jsCode).catch(() => {})
}

// ========== 创建VNC窗口 ==========
function createVNCWindows (config, groupIndex) {
  if (selectWindow) {
    selectWindow.close()
    selectWindow = null
  }

  const startIdx = (groupIndex - 1) * 5
  const groupItems = config.items.slice(startIdx, startIdx + 5)

  if (groupItems.length === 0) return

  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workAreaSize

  const winW = 853
  const winH = 520

  const cols = Math.min(groupItems.length, Math.floor(workArea.width / winW))
  const rows = Math.ceil(groupItems.length / cols)
  const totalWidth = cols * winW
  const offsetX = Math.floor((workArea.width - totalWidth) / 2)
  const offsetY = 0

  groupItems.forEach((item, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = offsetX + col * winW
    const y = offsetY + row * winH

    const win = new BrowserWindow({
      x: x,
      y: y,
      width: winW,
      height: winH,
      frame: false,
      transparent: true,
      title: item.title,
      useContentSize: true,
      show: true,
      backgroundColor: '#000000',
      webPreferences: {
        webgl: true,
        hardwareAcceleration: true,
        offscreen: false,
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    win.setMenu(null)

    win.on('page-title-updated', (event) => {
      event.preventDefault()
      win.setTitle(item.title)
    })

    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        setLayer2Title(win, item)
      }, 500)
    })

    win.loadURL(item.url)

    vncWindows.push(win)
  })

  createExitButton(vncWindows[0] || null)

  // ★ 启动HTTP API服务
  if (!apiServer) {
    startAPIServer(groupIndex)
  }
}

// ========== 主流程 ==========
app.whenReady().then(() => {
  const config = readConfig()

  if (!config) {
    const { dialog } = require('electron')
    dialog.showErrorBox('读取配置文件异常', '未找到配置文件！请将"配置文件.int"放在程序同目录下。')
    app.quit()
    return
  }

  if (config.groups.length === 0) {
    const { dialog } = require('electron')
    dialog.showErrorBox('配置异常', '配置文件中未找到分组信息！')
    app.quit()
    return
  }

  if (config.groups.length === 1) {
    createVNCWindows(config, config.groups[0].index)
  } else {
    showGroupSelector(config)
  }

  app.on('activate', function () {})
})

ipcMain.on('select-group', (event, groupIndex) => {
  const config = readConfig()
  createVNCWindows(config, groupIndex)
})

ipcMain.on('exit-app', () => {
  vncWindows.forEach(w => {
    try { w.destroy() } catch (e) {}
  })
  vncWindows.length = 0

  if (exitWindow) {
    try { exitWindow.destroy() } catch (e) {}
    exitWindow = null
  }

  if (apiServer) {
    apiServer.close()
    apiServer = null
  }

  app.quit()
  process.exit(0)
})

app.on('window-all-closed', function () {
  // 不自动退出，由退出按钮控制
})
