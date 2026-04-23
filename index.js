const { app, BrowserWindow } = require('electron')

function createWindow () {
  // 创建无边框无标题窗口，开启GPU加速
  const mainWindow = new BrowserWindow({
    width: 853,
    height: 480,
    frame: false, // 无边框无标题
    titleBarStyle: 'hidden',
    useContentSize: true,
    webPreferences: {
      webgl: true, // 开启WebGL支持GPU渲染
      hardwareAcceleration: true,
      offscreen: false
    }
  })

  // 关闭菜单栏
  mainWindow.setMenu(null)

  // 加载指定的noVNC地址
  mainWindow.loadURL('http://neiwang.hogan.ltd/novnc/iPhone_853x480_run.html?token=01&IP=172.16.103.201')

  // 开启开发者工具（可选，调试用）
  // mainWindow.webContents.openDevTools()
}

// 启用GPU硬件加速
app.commandLine.appendSwitch('enable-gpu')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

// 当Electron完成初始化并准备创建浏览器窗口时调用此方法
app.whenReady().then(() => {
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 当所有窗口都关闭时退出，除了 macOS
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})
