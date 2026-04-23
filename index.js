const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const iconv = require('iconv-lite')

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
  // 按优先级查找配置文件：exe同目录 → 当前工作目录 → app根目录
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

  if (!configPath) {
    return null
  }

  // 用GBK编码读取（易语言配置文件默认GBK）
  const rawBuf = fs.readFileSync(configPath)
  const content = iconv.decode(rawBuf, 'gbk')

  const config = {
    groups: [],   // [{name: 'D'}, {name: 'E'}, ...]
    items: []     // [{url, title, controlIP}, ...]
  }

  // 解析组
  for (let i = 1; i <= 10; i++) {
    const match = content.match(new RegExp(`组${i}名称=(.+)`, 'm'))
    if (match && match[1].trim()) {
      config.groups.push({ index: i, name: match[1].trim() })
    }
  }

  // 解析每个条目
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

  // 生成选组界面HTML
  let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { 
    font-family: "Microsoft YaHei", sans-serif; 
    background: #1a1a2e; 
    color: #eee; 
    padding: 20px;
  }
  h2 { text-align: center; margin-bottom: 18px; color: #e94560; font-size: 18px; }
  .group-btn {
    display: block;
    width: 100%;
    padding: 14px;
    margin-bottom: 12px;
    font-size: 16px;
    font-weight: bold;
    color: #fff;
    background: #16213e;
    border: 2px solid #e94560;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .group-btn:hover { background: #e94560; }
</style>
</head>
<body>
<h2>选择要启动的分组</h2>`

  config.groups.forEach((g, idx) => {
    const startIdx = (g.index - 1) * 5 + 1
    const endIdx = g.index * 5
    html += `<button class="group-btn" onclick="selectGroup(${g.index})">控制 ${g.name} 组（编号 ${startIdx}-${endIdx}）</button>\n`
  })

  html += `<script>
    const { ipcRenderer } = require('electron')
    function selectGroup(groupIndex) {
      ipcRenderer.send('select-group', groupIndex)
    }
  </script>
</body></html>`

  selectWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ========== 创建VNC窗口 ==========
function createVNCWindows (config, groupIndex) {
  // 关闭选组窗口
  if (selectWindow) {
    selectWindow.close()
    selectWindow = null
  }

  // 计算该组的起始编号 (组1→1-5, 组2→6-10, 组3→11-15)
  const startIdx = (groupIndex - 1) * 5
  const groupItems = config.items.slice(startIdx, startIdx + 5)

  if (groupItems.length === 0) {
    return
  }

  // 屏幕尺寸计算排列位置：5个窗口横排
  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const screenWidth = primaryDisplay.workAreaSize.width
  const screenHeight = primaryDisplay.workAreaSize.height

  // 窗口大小（根据noVNC内容调整）
  const winW = 853
  const winH = 480

  // 计算窗口排列：尽量铺满屏幕
  const cols = Math.min(groupItems.length, Math.floor(screenWidth / winW))
  const rows = Math.ceil(groupItems.length / cols)
  const offsetX = Math.floor((screenWidth - cols * winW) / 2)
  const offsetY = Math.floor((screenHeight - rows * winH) / 2)

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
      frame: false,           // 无边框
      title: item.title,      // 第一层标题 = 窗口标题
      useContentSize: true,
      show: true,
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

    // ★ 关键：设置第一层窗口标题（Chrome_WidgetWin_1 的标题）
    win.setTitle(item.title)

    // ★ 关键：通过注入JS修改第二层（Chrome_RenderWidgetHostHWND）的属性
    // 在页面加载完成后，给 document.title 设置为 "编号|控制IP" 格式
    // 这样大漠插件可以通过 AccessibleName 或其他方式获取到
    win.webContents.on('did-finish-load', () => {
      // 第二层标题 = 编号|控制IP
      const renderTitle = `${item.index}|${item.controlIP}`
      win.webContents.executeJavaScript(`
        document.title = '${renderTitle}';
      `)
      // 同时保持第一层标题为窗口标题
      win.setTitle(item.title)
    })

    // 加载对应的URL
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

  // 如果只有1组，直接启动，不需要选组界面
  if (config.groups.length === 1) {
    createVNCWindows(config, config.groups[0].index)
  } else {
    // 多组，显示选组界面
    showGroupSelector(config)
  }

  app.on('activate', function () {
    // macOS 专用，不需要处理
  })
})

// 接收选组消息
ipcMain.on('select-group', (event, groupIndex) => {
  const config = readConfig()
  createVNCWindows(config, groupIndex)
})

app.on('window-all-closed', function () {
  app.quit()
})
