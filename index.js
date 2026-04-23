const { app, BrowserWindow } = require('electron')

// ========== 关键：禁用 DirectComposition，让渲染走 GDI 可见管线 ==========
// 这样大漠插件 GDI BitBlt 截图才不会黑屏，行为与易语言+CEF3父句柄方式一致
app.commandLine.appendSwitch('disable-direct-composition')
// 禁用 GPU 进程沙箱（部分环境下 GPU 进程受限也会导致截图黑屏）
app.commandLine.appendSwitch('no-sandbox')

// ========== GPU 加速保留 ==========
app.commandLine.appendSwitch('enable-gpu')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

// ========== 禁用后台节流，保证远程画面持续刷新 ==========
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

function createWindow () {
  const mainWindow = new BrowserWindow({
    width: 853,
    height: 480,
    frame: false,          // 无边框无标题
    titleBarStyle: 'hidden',
    useContentSize: true,
    show: true,
    webPreferences: {
      webgl: true,
      hardwareAcceleration: true,
      offscreen: false,
      backgroundThrottling: false  // 禁止后台节流
    }
  })

  // 关闭菜单栏
  mainWindow.setMenu(null)

  // 加载指定的noVNC地址
  mainWindow.loadURL('http://neiwang.hogan.ltd/novnc/iPhone_853x480_run.html?token=01&IP=172.16.103.201')

  // ESC键退出程序
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      app.quit()
    }
  })

  // 开启开发者工具（调试用，取消注释即可）
  // mainWindow.webContents.openDevTools()
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})
