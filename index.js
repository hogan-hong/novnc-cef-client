const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const iconv = require('iconv-lite')
const { execFile } = require('child_process')

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

  // GBK编码读取（易语言配置文件默认GBK）
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

// ========== Windows API：设置子窗口标题 + 去除DWM阴影 ==========
function applyWindowCustomizations (win, item, retryCount = 0) {
  const hwnd = win.getNativeWindowHandle()
  const hwndVal = hwnd.length === 8
    ? hwnd.readBigUInt64LE().toString(16)
    : hwnd.readUInt32LE().toString(16)
  const hwndHex = hwndVal.toUpperCase()
  const childTitle = `${item.index}|${item.controlIP}`

  // PowerShell脚本：设置Chrome Legacy Window标题 + 去除DWM阴影
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")]
  public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cn, string t);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool SetWindowTextW(IntPtr h, string t);
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")]
  public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int sz);
}
"@

$parent = [IntPtr]0x${hwndHex}
if ($parent -eq [IntPtr]::Zero) { exit 1 }

# 1. 查找并设置 Chrome Legacy Window 子窗口标题
$child = [WinAPI]::FindWindowEx($parent, [IntPtr]::Zero, "Chrome Legacy Window", $null)
if ($child -eq [IntPtr]::Zero) {
  # 子窗口可能还没创建，返回2让调用方重试
  [Console]::Exit(2)
}
[WinAPI]::SetWindowTextW($child, "${childTitle}")

# 2. 去除窗口阴影：通过DWM禁用NC渲染
$val = 2
[WinAPI]::DwmSetWindowAttribute($parent, 2, [ref]$val, 4)

# 3. 移除WS_THICKFRAME样式（消除边框光影）
$style = [WinAPI]::GetWindowLong($parent, -16)
$style = $style -band (-bnot 0x00040000)
[WinAPI]::SetWindowLong($parent, -16, $style)

# 4. 移除WS_EX_WINDOWEDGE扩展样式
$exStyle = [WinAPI]::GetWindowLong($parent, -20)
$exStyle = $exStyle -band (-bnot 0x00000100)
[WinAPI]::SetWindowLong($parent, -20, $exStyle)
`

  const tmpFile = path.join(app.getPath('temp'), `novnc_${item.index}_${Date.now()}.ps1`)
  fs.writeFileSync(tmpFile, psScript, 'utf-8')

  execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile], (err, stdout, stderr) => {
    // 清理临时文件
    fs.unlink(tmpFile, () => {})

    if (err) {
      // 退出码2表示子窗口还没创建，重试
      if (err.code === 2 || (err.message && err.message.includes('Exit Code: 2'))) {
        if (retryCount < 5) {
          setTimeout(() => applyWindowCustomizations(win, item, retryCount + 1), 500)
        }
      } else {
        console.error(`WinAPI error (window ${item.index}):`, err.message)
      }
    }
  })
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

  // 窗口排列：适配2K(2560x1440)，3个一行+2个一行
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
      frame: false,           // 无边框
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

    // ★ 注入CSS去除页面内阴影/边框
    win.webContents.on('did-finish-load', () => {
      win.webContents.insertCSS(`
        * { box-shadow: none !important; outline: none !important; }
        html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; border: none !important; }
      `)

      // ★ 通过Windows API设置第二层标题 + 去除DWM阴影
      setTimeout(() => {
        applyWindowCustomizations(win, item)
      }, 300)
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
