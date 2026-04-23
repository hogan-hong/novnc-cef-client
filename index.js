const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')

// ========== Windows API（koffi直接调用） ==========
let user32 = null
let FindWindowExW = null
let SetWindowTextW = null

function loadWinAPI () {
  try {
    const koffi = require('koffi')
    user32 = koffi.load('user32.dll')
    FindWindowExW = user32.func('FindWindowExW', 'pointer', ['pointer', 'pointer', 'string16', 'string16'])
    SetWindowTextW = user32.func('SetWindowTextW', 'bool', ['pointer', 'string16'])
    return true
  } catch (e) {
    console.error('Failed to load WinAPI:', e.message)
    return false
  }
}

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

// ========== 设置第二层窗口标题（Chrome Legacy Window） ==========
function setLayer2Title (win, item, retryCount = 0) {
  if (!FindWindowExW) return

  try {
    const hwndBuf = win.getNativeWindowHandle()
    const koffi = require('koffi')
    const hwnd = koffi.as(hwndBuf, 'pointer')
    if (!hwnd) return

    // 查找 Chrome Legacy Window 子窗口
    const child = FindWindowExW(hwnd, null, 'Chrome Legacy Window', null)
    if (!child) {
      if (retryCount < 10) {
        setTimeout(() => setLayer2Title(win, item, retryCount + 1), 500)
      }
      return
    }

    const childTitle = `${item.index}|${item.controlIP}`
    SetWindowTextW(child, childTitle)
    console.log(`Window ${item.index}: layer2 title set to "${childTitle}"`)

  } catch (e) {
    console.error(`setLayer2Title error (window ${item.index}):`, e.message)
    if (retryCount < 10) {
      setTimeout(() => setLayer2Title(win, item, retryCount + 1), 500)
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
  const winH = 480

  // 5个窗口适配2K：3+2排列居中
  const cols = Math.min(groupItems.length, Math.floor(workArea.width / winW))
  const rows = Math.ceil(groupItems.length / cols)
  const totalWidth = cols * winW
  const totalHeight = rows * winH
  const offsetX = Math.floor((workArea.width - totalWidth) / 2)
  const offsetY = Math.floor((workArea.height - totalHeight) / 2)

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
      title: item.title,      // ★ 第一层标题 = 窗口标题
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

    // ★ 防止页面title变更覆盖第一层标题
    win.on('page-title-updated', (event) => {
      event.preventDefault()
      win.setTitle(item.title)
    })

    // ★ 页面加载后设置第二层标题
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        setLayer2Title(win, item)
      }, 500)
    })

    // 加载URL
    win.loadURL(item.url)

    // ESC键退出该窗口
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'Escape') {
        win.close()
      }
    })
  })
}

// ========== 主流程 ==========
app.whenReady().then(() => {
  loadWinAPI()

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

app.on('window-all-closed', function () {
  app.quit()
})
