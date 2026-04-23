const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
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

// ========== 设置第二层窗口标题（写ps1文件执行，避免引号转义问题） ==========
function setLayer2Title (win, item, retryCount = 0) {
  try {
    const hwndBuf = win.getNativeWindowHandle()
    // 读取hwnd的16进制值
    let hwndHex
    if (hwndBuf.length === 8) {
      // 8字节，可能是32位系统上对齐到8字节，实际有效值在低4字节
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

    // 写临时ps1文件执行，避免命令行引号转义问题
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
  # 子窗口可能还没创建，也尝试遍历子窗口查找
  $child = [Win32]::GetWindow($parent, 5)  # GW_CHILD = 5
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
      // 清理临时文件
      try { fs.unlinkSync(tmpFile) } catch (e) {}

      const output = (stdout || '').trim()
      if (output === 'RETRY' && retryCount < 15) {
        setTimeout(() => setLayer2Title(win, item, retryCount + 1), 600)
      } else if (output === 'OK') {
        console.log(`Window ${item.index}: layer2 title set to "${childTitle}"`)
      } else {
        console.log(`Window ${item.index}: ps1 output="${output}", stderr="${(stderr||'').trim()}"`)
        if (retryCount < 15) {
          setTimeout(() => setLayer2Title(win, item, retryCount + 1), 600)
        }
      }
    })
  } catch (e) {
    console.error(`setLayer2Title error (window ${item.index}):`, e.message)
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
    parent: parentWin,       // ★ 挂到VNC窗口下，跟随虚拟桌面
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

// ========== 创建VNC窗口 ==========
const vncWindows = []

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
  const winH = 500

  const cols = Math.min(groupItems.length, Math.floor(workArea.width / winW))
  const rows = Math.ceil(groupItems.length / cols)
  const totalWidth = cols * winW
  const totalHeight = rows * winH
  const offsetX = Math.floor((workArea.width - totalWidth) / 2)
  const offsetY = 0   // ★ 从屏幕最顶部开始排列

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

    // ★ 页面加载后设置第二层标题 + 注入黑色背景
    win.webContents.on('did-finish-load', () => {
      win.webContents.insertCSS(`
        html, body { background: #000 !important; overflow: hidden !important; }
      `)
      // ★ 页面内容贴顶：滚到最顶部
      win.webContents.executeJavaScript('window.scrollTo(0, 0)').catch(() => {})
      setTimeout(() => {
        setLayer2Title(win, item)
      }, 500)
    })

    // 加载URL
    win.loadURL(item.url)

    vncWindows.push(win)
  })

  // ★ 创建右下角退出按钮，挂到第一个VNC窗口下
  createExitButton(vncWindows[0] || null)
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

// 选组消息
ipcMain.on('select-group', (event, groupIndex) => {
  const config = readConfig()
  createVNCWindows(config, groupIndex)
})

// ★ 退出程序：先关闭所有窗口，再退出
ipcMain.on('exit-app', () => {
  // 关闭所有VNC窗口
  vncWindows.forEach(w => {
    try { w.destroy() } catch (e) {}
  })
  vncWindows.length = 0

  // 关闭退出按钮窗口
  if (exitWindow) {
    try { exitWindow.destroy() } catch (e) {}
    exitWindow = null
  }

  // 强制退出
  app.quit()
  process.exit(0)
})

// 不自动退出，由退出按钮控制
app.on('window-all-closed', function () {
  // 不退出，退出按钮窗口还在
})
