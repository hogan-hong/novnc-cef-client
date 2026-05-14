const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const http = require('http')

// ========== 日志写入（优先exe同目录，失败则回退到用户目录/临时目录）==========
function pickWritableLogPath () {
  const dirs = [
    path.dirname(app.getPath('exe')),
    app.getPath('userData'),
    path.join(app.getPath('temp'), 'NoVNC Client')
  ]

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const candidate = path.join(dir, 'Log.txt')
      fs.writeFileSync(candidate, `[${new Date().toLocaleString('zh-CN', {hour12:false})}] === NoVNC Client 启动 ===\n`, 'utf-8')
      return candidate
    } catch (e) {}
  }

  return path.join(path.dirname(app.getPath('exe')), 'Log.txt')
}

let logPath = pickWritableLogPath()
const origLog = console.log
const origErr = console.error
let _logBuffer = []
let _logFlushTimer = null

function writeLog (msg) {
  const line = `[${new Date().toLocaleString('zh-CN', {hour12:false})}] ${msg}\n`
  _logBuffer.push(line)
  // 缓冲区满100条或首次立即刷，其他攒着3秒一刷
  if (_logBuffer.length >= 100) flushLog()
  else if (!_logFlushTimer) _logFlushTimer = setTimeout(flushLog, 3000)
}
function flushLog () {
  if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null }
  if (_logBuffer.length === 0) return
  const data = _logBuffer.join('')
  _logBuffer = []
  fs.writeFile(logPath, data, { flag: 'a', encoding: 'utf-8' }, (err) => {
    if (!err) return
    logPath = pickWritableLogPath()
    fs.writeFile(logPath, data, { flag: 'a', encoding: 'utf-8' }, () => {})
  })
}
console.log = function () { writeLog([...arguments].map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); origLog.apply(console, arguments) }
console.error = function () { writeLog('ERR: ' + [...arguments].map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); origErr.apply(console, arguments) }

// ★ 启动时立即写入日志，确保日志系统工作
console.log('========== NoVNC Client 启动开始 ==========')
console.log('日志文件:', logPath)
console.log('进程ID:', process.pid)
console.log('Node版本:', process.version)
console.log('Electron版本:', process.versions.electron)
console.log('平台:', process.platform)
console.log('架构:', process.arch)

// ★ 全局错误处理：捕获未处理的异常和Promise rejection
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && (err.stack || err.message || err))
  try {
    require('electron').dialog.showErrorBox('启动失败', err && (err.stack || err.message || String(err)))
  } catch (e) {}
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && (reason.stack || reason.message || reason))
})

// 禁用 DirectComposition，保证GDI截图不黑屏
app.commandLine.appendSwitch('disable-direct-composition')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('enable-gpu')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('disable-background-timer-throttling')
// ★ 强制DPI为1，避免高DPI屏幕下Canvas渲染4倍像素量
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
// ★ 关闭音频服务，VNC不需要声音，省一个Utility进程
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess')
app.commandLine.appendSwitch('mute-audio')
// ★ 隐藏窗口优化：保持GPU渲染和事件处理
app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder')
app.commandLine.appendSwitch('enable-zero-copy')

// ========== 全局状态 ==========
let controlMode = false        // 控制模式：每个窗口显示主控+刷新按钮
let currentGroupIndex = 1
const vncWindows = []          // 辅助窗口数组（大漠绑定这些窗口）
const osrWindows = []          // OSR离屏浏览器窗口数组
const windowDrawTimes = []     // 每个窗口的最后一次绘制时间（限帧）
let apiServer = null
let controlBarWindow = null    // 右下角控制栏窗口
let selectWindow = null
let startupErrorWindow = null
let refreshBtnWindows = []     // 每个辅助窗口的刷新按钮窗口（浮动，置顶）

// OSR配置：固定帧率，降低CPU/GPU负载
const OSR_FRAME_RATE = 10  // 每个窗口10fps
const OSR_FRAME_INTERVAL = 1000 / OSR_FRAME_RATE

// OSR日志开关 (默认关闭，避免生产环境日志爆炸)
// 启用方式1: 命令行参数 --osr-logs
// 启用方式2: 配置文件 [System] OSR_LOG=1
let enableOsrLogging = process.argv.includes('--osr-logs')

// ★ 主控窗口索引，-1=无主控，≥0=主控窗口索引
// 只有主控窗口的输入会同步到其他窗口
let masterWindowIndex = -1

// ★ Canvas 信息缓存：每个窗口的 canvas 尺寸和位置
const canvasInfoCache = {}

// ========== 读取配置文件（支持 --config=路径 启动参数）==========
function readConfig () {
  // 支持启动参数指定配置文件：--config=路径
  const configArg = process.argv.find(a => a.startsWith('--config='))
  let configPath
  if (configArg) {
    configPath = configArg.substring(9) // '--config='.length = 9
    if (!path.isAbsolute(configPath)) {
      configPath = path.resolve(path.dirname(app.getPath('exe')), configPath)
    }
  } else {
    const candidates = [
      path.join(path.dirname(app.getPath('exe')), '配置文件.int'),
      path.join(process.cwd(), '配置文件.int'),
      path.join(__dirname, '配置文件.int'),
      path.join(process.resourcesPath || '', '配置文件.int')
    ].filter(Boolean)
    configPath = candidates.find(p => fs.existsSync(p)) || candidates[0]
    console.log(`配置文件查找路径: ${candidates.join(' | ')}`)
  }
  if (!fs.existsSync(configPath)) {
    require('electron').dialog.showErrorBox('配置文件不存在', `未找到配置文件！\n路径: ${configPath}\n请将 配置文件.int 放在exe同目录下，或通过 --config=路径 指定`)
    return null
  }
  console.log(`使用配置文件: ${configPath}`)
  try {
    const rawBuf = fs.readFileSync(configPath)
    const iconv = require('iconv-lite')
    // 自动检测编码：先UTF-8，解析不到分组则GBK
    let content = rawBuf.toString('utf-8')
    if (!content.includes('组') || content.includes('')) {
      content = iconv.decode(rawBuf, 'gbk')
    }
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
    if (config.groups.length === 0) {
      require('electron').dialog.showErrorBox('配置异常', `未找到分组信息！\n请检查 配置文件.int 中的 组1名称 等字段`)
      return null
    }
    // 读取 OSR 日志开关
    const osrLogMatch = content.match(/OSR_LOG\s*=\s*([01])/i)
    if (osrLogMatch) {
      config.osrLogEnabled = osrLogMatch[1] === '1'
    }
    return config
  } catch (e) {
    require('electron').dialog.showErrorBox('读取配置文件失败', `文件: ${configPath}\n错误: ${e.message}`)
    return null
  }
}

function showStartupError (title, message) {
  console.error(`${title}: ${message}`)
  startupErrorWindow = new BrowserWindow({
    width: 720,
    height: 360,
    show: false,
    frame: true,
    title,
    resizable: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  startupErrorWindow.setMenu(null)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:"Microsoft YaHei",Arial,sans-serif;margin:0;padding:24px;background:#101820;color:#f4f7fb}
    h1{font-size:20px;margin:0 0 16px;color:#ffcc66}
    pre{white-space:pre-wrap;word-break:break-word;background:#172331;border:1px solid #33475f;padding:14px;border-radius:6px;line-height:1.5}
  </style></head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(message)}</pre></body></html>`
  startupErrorWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  startupErrorWindow.once('ready-to-show', () => {
    startupErrorWindow.show()
    startupErrorWindow.focus()
  })
}

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ========== 批量设置第二层窗口标题 ==========
// 用队列统一处理，避免15个窗口同时起PowerShell进程互相打架
const _titleQueue = []
let _titleProcessing = false
const CSHARP_HELPER = `
using System;using System.Runtime.InteropServices;
public class W{
  [DllImport("user32.dll")]public static extern IntPtr FindWindowEx(IntPtr p,IntPtr c,string n,string t);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern bool SetWindowText(IntPtr h,string s);
  [DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr h,uint c);
}`

function queueLayer2Title (win, item) {
  if (!win || win.isDestroyed()) return
  const hwndBuf = win.getNativeWindowHandle()
  let hwndHex
  if (hwndBuf.length === 8) {
    const lo = hwndBuf.readUInt32LE(0), hi = hwndBuf.readUInt32LE(4)
    hwndHex = hi === 0 ? lo.toString(16).toUpperCase() : hwndBuf.readBigUInt64LE().toString(16).toUpperCase()
  } else {
    hwndHex = hwndBuf.readUInt32LE(0).toString(16).toUpperCase()
  }
  _titleQueue.push({ hwndHex, title: `${item.index}|${item.controlIP}`, win, item })
  if (!_titleProcessing) processTitleQueue()
}

function processTitleQueue () {
  if (_titleQueue.length === 0) { _titleProcessing = false; return }
  _titleProcessing = true

  // 每批最多5个窗口，避免一次起太多
  const batch = _titleQueue.splice(0, 5)
  // Add-Type只编译一次，所有窗口共享
  const psLines = [`Add-Type -TypeDefinition '${CSHARP_HELPER}'`]
  batch.forEach(({ hwndHex, title }) => {
    psLines.push(`$c=[W]::FindWindowEx([IntPtr]0x${hwndHex},[IntPtr]::Zero,'Chrome Legacy Window',$null);if($c -eq [IntPtr]::Zero){$c=[W]::GetWindow([IntPtr]0x${hwndHex},5)};if($c -ne [IntPtr]::Zero){[W]::SetWindowText($c,'${title}');Write-Host 'OK_${hwndHex}'}else{Write-Host 'RETRY_${hwndHex}'}`)
  })
  const psScript = psLines.join('\n')
  const tmpFile = path.join(app.getPath('temp'), 'novnc_title_batch.ps1')

  try { fs.writeFileSync(tmpFile, psScript, 'utf-8') } catch (e) { _titleProcessing = false; return }

  execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive', '-File', tmpFile], { timeout: 15000 }, (err, stdout) => {
    try { fs.unlinkSync(tmpFile) } catch (e) {}
    const output = (stdout || '').trim()
    // 检查失败的，延迟后重新加入队列
    batch.forEach(({ hwndHex, title, win, item }) => {
      if (win.isDestroyed()) return
      if (!output.includes(`OK_${hwndHex}`)) {
        setTimeout(() => queueLayer2Title(win, item), 1000)
      }
    })
    // 处理下一批
    setTimeout(() => processTitleQueue(), 300)
  })
}

function setLayer2Title (win, item) {
  queueLayer2Title(win, item)
}

// ========== 选组界面 ==========
function showGroupSelector (config) {
  selectWindow = new BrowserWindow({
    width: 520,
    height: 120 + config.groups.length * 70,
    show: false,
    frame: true,
    title: 'NoVNC 群控 - 选择分组',
    resizable: false,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  selectWindow.setMenu(null)
  selectWindow.center()
  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;padding:20px}h2{text-align:center;margin-bottom:18px;color:#e94560;font-size:18px}.group-btn{display:block;width:100%;padding:14px;margin-bottom:12px;font-size:16px;font-weight:bold;color:#fff;background:#16213e;border:2px solid #e94560;border-radius:8px;cursor:pointer}.group-btn:hover{background:#e94560}</style></head><body><h2>选择要启动的分组</h2>`
  config.groups.forEach((g) => { const s = (g.index - 1) * 5 + 1, e = g.index * 5; html += `<button class="group-btn" onclick="selectGroup(${g.index})">控制 ${g.name} 组（编号 ${s}-${e}）</button>\n` })
  html += `<script>const{ipcRenderer}=require('electron');function selectGroup(i){ipcRenderer.send('select-group',i)}</script></body></html>`
  selectWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  selectWindow.once('ready-to-show', () => {
    selectWindow.show()
    selectWindow.focus()
  })
}

// ========== 右下角控制栏（控制 + 退出）==========
function createControlButtons (parentWin, windowCount = 5, windowTitles = []) {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  controlBarWindow = new BrowserWindow({
    x: workArea.width - 110, y: workArea.height - 40,
    width: 100, height: 30,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  controlBarWindow.setMenu(null)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:transparent;width:100px;height:30px;display:flex;gap:4px;justify-content:center;align-items:center}button{flex:1;height:30px;width:48px;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:bold;cursor:pointer;font-family:"Microsoft YaHei",sans-serif;white-space:nowrap}#controlBtn{background:#28a745}#controlBtn:hover{background:#218838}#controlBtn.active{background:#dc3545}#controlBtn.active:hover{background:#c82333}#exitBtn{background:#e94560}#exitBtn:hover{background:#c23152}</style></head><body><button id="controlBtn" onclick="toggleControl()">控制</button><button id="exitBtn" onclick="quit()">退出</button><script>const{ipcRenderer}=require('electron');let c=false;function toggleControl(){c=!c;const b=document.getElementById('controlBtn');if(c){b.textContent='关闭控制';b.classList.add('active')}else{b.textContent='控制';b.classList.remove('active')}ipcRenderer.send('toggle-control',c)}function quit(){ipcRenderer.send('exit-app')}</script></body></html>`
  controlBarWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ★★★ 同步事件捕获注入（按需注入，关闭控制时移除）★★★
function injectSyncCapture () {
  const apiPort = 38980 + currentGroupIndex
  osrWindows.forEach((win, i) => {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      (function() {
        if (window.__novnc_sync_injected) return;
        window.__novnc_sync_injected = true;
        var screen = document.getElementById('screen');
        if (!screen) return;
        var API_URL = 'http://127.0.0.1:${apiPort}/sync';
        var WIN_IDX = ${i};
        var _lastMoveSync = 0;
        window.__novnc_sync_handlers = [];

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

        function addSyncListener(target, et, fn, capture) {
          target.addEventListener(et, fn, capture);
          window.__novnc_sync_handlers.push({target:target, et:et, fn:fn, capture:capture});
        }

        // 鼠标按下/抬起
        ['mousedown', 'mouseup'].forEach(function(et) {
          addSyncListener(screen, et, function(e) {
            var canvas = screen.querySelector('canvas');
            if (!canvas) return;
            var rect = canvas.getBoundingClientRect();
            var realX = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
            var realY = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
            sendSync({type:'sync-mouse', eventType:et, x:realX, y:realY, buttons:e.buttons, button:e.button});
          }, true);
        });
        // mousemove 节流30ms
        addSyncListener(screen, 'mousemove', function(e) {
          var now = Date.now();
          if (now - _lastMoveSync < 30) return;
          _lastMoveSync = now;
          var canvas = screen.querySelector('canvas');
          if (!canvas) return;
          var rect = canvas.getBoundingClientRect();
          var realX = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
          var realY = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
          sendSync({type:'sync-mouse', eventType:'mousemove', x:realX, y:realY, buttons:e.buttons, button:e.button});
        }, true);
        // 滚轮
        addSyncListener(document, 'wheel', function(e) {
          var canvas = screen.querySelector('canvas');
          if (!canvas) return;
          var rect = canvas.getBoundingClientRect();
          var realX = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
          var realY = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
          sendSync({type:'sync-wheel', deltaY:e.deltaY, deltaX:e.deltaX, x:realX, y:realY});
        }, true);
      })()
    `).catch(() => {})
  })
}

function removeSyncCapture () {
  vncWindows.forEach((win) => {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      (function() {
        if (!window.__novnc_sync_injected) return;
        window.__novnc_sync_injected = false;
        if (window.__novnc_sync_handlers) {
          window.__novnc_sync_handlers.forEach(function(h) {
            h.target.removeEventListener(h.et, h.fn, h.capture);
          });
          window.__novnc_sync_handlers = null;
        }
      })()
    `).catch(() => {})
  })
}

// ========== 控制按钮：在每个VNC窗口内注入（刷新）==========
function injectControlButtons () {
  var apiPort = 38980 + currentGroupIndex;
  osrWindows.forEach((win, i) => {
    if (!win || win.isDestroyed()) return
    var windowIndex = i + 1;
    win.webContents.executeJavaScript(`
      (function() {
        // 避免重复注入：已有控制栏时显示
        var existingBar = document.getElementById('__novnc_control_bar');
        if (existingBar) {
          existingBar.style.display = 'flex';
          return;
        }
        var bar = document.createElement('div');
        bar.id = '__novnc_control_bar';
        bar.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:999999;display:flex;gap:4px;';

        // 刷新按钮
        var refreshBtn = document.createElement('div');
        refreshBtn.id = '__novnc_refresh_btn';
        refreshBtn.style.cssText = 'padding:4px 10px;border-radius:4px;color:#fff;font-size:12px;font-weight:bold;font-family:"Microsoft YaHei",sans-serif;cursor:pointer;user-select:none;opacity:0.85;transition:opacity 0.2s;background:#007bff;';
        refreshBtn.textContent = '刷新';
        refreshBtn.addEventListener('mouseenter', function(){ refreshBtn.style.opacity = '1'; });
        refreshBtn.addEventListener('mouseleave', function(){ refreshBtn.style.opacity = '0.85'; });
        ['mousedown', 'mouseup'].forEach(function(et) {
          refreshBtn.addEventListener(et, function(e){ e.stopPropagation(); e.preventDefault(); }, true);
        });
        refreshBtn.addEventListener('click', function(e){
          e.stopPropagation();
          e.preventDefault();
          try {
            var apiUrl = 'http://127.0.0.1:${apiPort}/refresh';
            var requestData = { windowIndex: ${windowIndex} };
            console.log('[刷新按钮] 发送请求:', apiUrl, requestData);
            
            // 添加 alert 提示
            alert('刷新窗口 ${windowIndex}: 正在发送请求到 ' + apiUrl);
            
            fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestData)
            }).then(function(res){
              console.log('[刷新按钮] 响应状态:', res.status);
              alert('刷新窗口 ${windowIndex}: 响应状态 ' + res.status);
              return res.text();
            }).then(function(text){
              console.log('[刷新按钮] 响应内容:', text);
              alert('刷新窗口 ${windowIndex}: 响应内容 ' + text);
            }).catch(function(err){
              console.error('[刷新按钮] 请求失败:', err);
              alert('刷新窗口 ${windowIndex}: 请求失败 - ' + err.message);
            });
          } catch(ex) {
            console.error('[刷新按钮] 异常:', ex);
            alert('刷新窗口 ${windowIndex}: 异常 - ' + ex.message);
          }
        }, true);

        bar.appendChild(refreshBtn);
        document.body.appendChild(bar);
      })()
    `).catch(() => {})
  })
}

function removeControlButtons () {
  osrWindows.forEach((win) => {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      var bar = document.getElementById('__novnc_control_bar');
      if (bar) bar.style.display = 'none';
    `).catch(() => {})
  })
}



// ========== 刷新 canvas 信息缓存 ==========
function refreshCanvasInfo (win, idx, retryCount = 0) {
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
    if (info) {
      canvasInfoCache[idx] = info
    } else if (retryCount < 10) {
      setTimeout(() => refreshCanvasInfo(win, idx, retryCount + 1), 2000)
    }
  }).catch(() => {
    if (retryCount < 10) setTimeout(() => refreshCanvasInfo(win, idx, retryCount + 1), 2000)
  })
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

// ★★★ 固定横屏分辨率 ★★★
// API坐标基于客户端分辨率 856×480
// 实际手机分辨率 1334×750
// API流程：越界检查(856×480) → 纯数学算viewport(不需要canvas缓存) → sendInputEvent
const CLIENT_WIDTH = 856
const CLIENT_HEIGHT = 480
const PHONE_WIDTH = 1334
const PHONE_HEIGHT = 750

// ★ API坐标 → viewport坐标（纯数学计算，不需要canvas缓存）
// 1. API坐标(856×480) → 手机分辨率(1334×750)
// 2. 手机分辨率 → 窗口viewport（用getContentSize算scale和居中偏移）
function apiToViewport (apiX, apiY, win) {
  const [winW, winH] = win.getContentSize()
  const scale = Math.min(winW / PHONE_WIDTH, winH / PHONE_HEIGHT)
  const vpX = Math.round(apiX * (PHONE_WIDTH / CLIENT_WIDTH) * scale)
  const vpY = Math.round(apiY * (PHONE_HEIGHT / CLIENT_HEIGHT) * scale)
  return { x: vpX, y: vpY }
}

// ★★★ 同步核心逻辑 — sendInputEvent + 主控切换 ★★★
// 只有主控窗口 (masterWindowIndex) 的输入会同步到其他窗口
// 控制模式开启 + 有主控窗口时才转发同步事件
// 其他窗口可以正常单独操作，不会影响别的窗口

// ========== 同步：转发鼠标事件到其他窗口 ==========
function forwardMouseEvent (sourceIdx, data) {
  if (!controlMode || masterWindowIndex < 0) return
  if (sourceIdx !== masterWindowIndex) return

  const { eventType, x: vncX, y: vncY, button } = data

  osrWindows.forEach((win, i) => {
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
  if (!controlMode || masterWindowIndex < 0) return
  if (sourceIdx !== masterWindowIndex) return

  osrWindows.forEach((win, i) => {
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
  if (!controlMode || masterWindowIndex < 0) return
  if (sourceIdx !== masterWindowIndex) return

  osrWindows.forEach((win, i) => {
    if (i === sourceIdx || !win || win.isDestroyed()) return
    if (!canvasInfoCache[i]) refreshCanvasInfo(win, i)

    const vp = vncToViewport(data.x, data.y, i)
    if (!vp) return

    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: vp.x, y: vp.y,
      deltaX: -data.deltaX,
      deltaY: -data.deltaY,
      canScroll: true
    })
  })
}

// ========== HTTP API 服务 ==========
function startAPIServer (groupIndex, config) {
  const port = 38980 + groupIndex
  currentGroupIndex = groupIndex
  if (apiServer) { try { apiServer.close() } catch (e) {} apiServer = null }

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }


    // ★ 刷新窗口画面
    if (req.method === 'POST' && req.url === '/refresh') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          console.log(`[API /refresh] 收到请求:`, data)
          const refreshIdx = (data.windowIndex || 1) - 1  // 1-based → 0-based
          console.log(`[API /refresh] 转换后的索引: ${refreshIdx} (0-based), osrWindows.length=${osrWindows.length}`)
          if (refreshIdx >= 0 && refreshIdx < osrWindows.length) {
            const refreshWin = osrWindows[refreshIdx]
            if (refreshWin && !refreshWin.isDestroyed()) {
              console.log(`刷新窗口 ${refreshIdx + 1} 画面`)
              refreshWin.webContents.reload()
              console.log(`[API /refresh] 窗口 ${refreshIdx + 1} 重新加载已发送`)
            } else {
              console.error(`[API /refresh] 窗口 ${refreshIdx + 1} 已销毁或不存在`)
            }
          } else {
            console.error(`[API /refresh] 窗口索引越界: ${refreshIdx}`)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (e) {
          console.error(`[API /refresh] 处理失败:`, e)
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

    // ★ 诊断端点
    if (req.method === 'GET' && req.url.startsWith('/diag')) {
      const urlObj = new URL(req.url, `http://127.0.0.1:${port}`)
      const diagIdx = parseInt(urlObj.searchParams.get('win') || '1') - 1  // 1-based → 0-based
      const diagWin = osrWindows[diagIdx]
      if (!diagWin || diagWin.isDestroyed()) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({error: 'window not found'}))
        return
      }
      diagWin.webContents.executeJavaScript(`
        (function() {
          var s = document.getElementById('screen');
          if (!s) return JSON.stringify({err:'NO_SCREEN'});
          var c = s.querySelector('canvas');
          if (!c) return JSON.stringify({err:'NO_CANVAS'});
          var rect = c.getBoundingClientRect();
          return JSON.stringify({
            canvasW: c.width, canvasH: c.height,
            rectLeft: rect.left, rectTop: rect.top, rectW: rect.width, rectH: rect.height,
            scaleX: (c.width / rect.width).toFixed(2),
            scaleY: (c.height / rect.height).toFixed(2)
          });
        })()
      `).then(r => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(r)
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({error: e.message}))
      })
      return
    }

    // ★ 打开DevTools端点
    if (req.method === 'GET' && req.url.startsWith('/devtools')) {
      const urlObj = new URL(req.url, `http://127.0.0.1:${port}`)
      const devIdx = parseInt(urlObj.searchParams.get('win') || '1') - 1  // 1-based → 0-based
      const devWin = osrWindows[devIdx]
      if (devWin && !devWin.isDestroyed()) {
        devWin.webContents.openDevTools()
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('DevTools opened for window ' + devIdx)
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Window not found')
      }
      return
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        success: true,
        windowCount: osrWindows.length,
        control: controlMode,
        master: masterWindowIndex,
        sync: controlMode && masterWindowIndex >= 0,
        port
      }))
      return
    }
    res.writeHead(404); res.end('Not Found')
  })
  server.listen(port, '0.0.0.0', () => console.log(`API + Sync on http://0.0.0.0:${port}`))
  apiServer = server
}

// ========== HTTP API: 外部控制命令 ==========
// ★ 每个窗口的拖动状态：{ timers: number[], resolved: boolean, resolve: Function }
// click 来了就立刻 cancelDrag 中断所有 timer 并释放左键，不等 setTimeout
const _dragState = {}

// ★ 中断指定窗口的拖动：取消所有未触发的 timer，发 mouseUp 释放左键
function cancelDrag (winIdx) {
  const state = _dragState[winIdx]
  if (!state) return
  // 取消所有未触发的 setTimeout
  state.timers.forEach(t => clearTimeout(t))
  state.timers.length = 0
  if (!state.resolved) {
    state.resolved = true
    const win = osrWindows[winIdx]
    if (win && !win.isDestroyed()) {
      const lastX = state.lastX != null ? state.lastX : 0
      const lastY = state.lastY != null ? state.lastY : 0
      win.webContents.sendInputEvent({ type: 'mouseUp', x: lastX, y: lastY, button: 'left', clickCount: 1 })
    }
    if (state.resolve) state.resolve()
  }
  delete _dragState[winIdx]
}

async function handleControlCommand (data) {
  // ★ 解析 windowIndex：字符串中每个字符代表一个窗口编号（1-based）
  // "1" → 窗口1, "5" → 窗口5, "13" → 窗口1+3, "15" → 窗口1+5, "12345" → 群控全部
  const wi = data.windowIndex
  let indices = []
  if (typeof wi === 'string' && wi.length > 0) {
    for (const ch of wi) {
      const num = parseInt(ch)
      // 1-based → 0-based内部索引
      const idx = num - 1
      if (!isNaN(num) && num >= 1 && idx < osrWindows.length) {
        indices.push(idx)
      }
    }
  } else if (typeof wi === 'number') {
    // 兼容旧版：数字0当作窗口1，数字1+直接用
    const idx = wi <= 0 ? 0 : wi - 1
    if (idx >= 0 && idx < osrWindows.length) indices.push(idx)
  } else {
    indices.push(0) // 默认窗口1
  }
  if (indices.length === 0) throw new Error('No valid windowIndex')
  // 去重
  indices = [...new Set(indices)]
  for (const idx of indices) {
    const win = osrWindows[idx]
    if (!win || win.isDestroyed()) continue
    sendToVNC(idx, data)
  }
  return `Sent to window ${indices.map(i => i + 1).join(',')}`
}

// ★★★ sendToVNC: API控制 → VNC窗口 ★★★
// 固定横屏 856×480 → 1334×750，纯数学算viewport，不依赖canvas缓存
function sendToVNC (winIdx, data) {
  const win = osrWindows[winIdx]
  if (!win || win.isDestroyed()) return
  const { action, x, y, deltaY, deltaX, text, code, down } = data

  // 剪贴板走executeJavaScript
  if (action === 'clipboard') {
    win.webContents.executeJavaScript(`
      (function(){
        var r = window.__rfb;
        if(r && r.clipboardPasteFrom) { r.clipboardPasteFrom(${JSON.stringify(text || '')}); return; }
      })()
    `).catch(() => {})
    return
  }

  // 键盘走sendInputEvent
  if (action === 'keypress') {
    const keyCode = code || ''
    if (down === true) {
      // 显式传 down=true → 只发按下
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, code: keyCode })
    } else if (down === false) {
      // 显式传 down=false → 只发抬起
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, code: keyCode })
    } else {
      // 不传 down → 完整按一下（按下+抬起）
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, code: keyCode })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, code: keyCode })
    }
    return
  }

  // ★★★ 拖动事件 ★★★
  if (action === 'drag') {
    const fromX = data.fromX != null ? data.fromX : 0
    const fromY = data.fromY != null ? data.fromY : 0
    const toX = data.toX != null ? data.toX : fromX
    const toY = data.toY != null ? data.toY : fromY
    const duration = data.duration || 300  // 默认300ms
    const mode = data.mode || 'uniform'    // 'uniform' 匀速 | 'ease' 模拟拖动（先加速后减速）
    const hold = data.hold || 0            // 到达终点后保持按住的时间(ms)，0=立即松开

    // 越界检查：起点和终点都基于 856×480
    if (fromX < 0 || fromX >= CLIENT_WIDTH || fromY < 0 || fromY >= CLIENT_HEIGHT) return
    if (toX < 0 || toX >= CLIENT_WIDTH || toY < 0 || toY >= CLIENT_HEIGHT) return

    const vpFrom = apiToViewport(fromX, fromY, win)
    const vpTo = apiToViewport(toX, toY, win)

    // 计算步数：至少2步（起终），最多100步，间隔约16ms（60fps）
    const steps = Math.max(2, Math.min(100, Math.round(duration / 16)))
    const stepTime = duration / steps

    // easeInOut 缓动函数：t ∈ [0,1] → [0,1]
    function easeInOut (t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    }

    // ★ 先取消该窗口之前未完成的 drag（如果连续发 drag）
    cancelDrag(winIdx)

    const timers = []
    const state = { timers, resolved: false, resolve: null, lastX: vpFrom.x, lastY: vpFrom.y }
    _dragState[winIdx] = state

    // 按下起点
    console.log(`[DRAG] win${winIdx} mouseDown at (${vpFrom.x},${vpFrom.y}) duration=${duration} hold=${hold} steps=${steps}`)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: vpFrom.x, y: vpFrom.y, button: 'left', clickCount: 1 })

    // 中间移动步
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      const et = mode === 'ease' ? easeInOut(t) : t  // ease模式用缓动，否则匀速
      const curX = Math.round(vpFrom.x + (vpTo.x - vpFrom.x) * et)
      const curY = Math.round(vpFrom.y + (vpTo.y - vpFrom.y) * et)
      const delay = Math.round(stepTime * i)
      timers.push(setTimeout(() => {
        if (state.resolved || win.isDestroyed()) return
        state.lastX = curX; state.lastY = curY  // ★ 记录最后位置
        win.webContents.sendInputEvent({ type: 'mouseMove', x: curX, y: curY })
      }, delay))
    }

    // 抬起终点（拖动结束后 hold 毫秒再松开）
    timers.push(setTimeout(() => {
      if (state.resolved || win.isDestroyed()) return
      state.lastX = vpTo.x; state.lastY = vpTo.y
      console.log(`[DRAG] win${winIdx} mouseUp at (${vpTo.x},${vpTo.y}) after ${duration + hold}ms`)
      win.webContents.sendInputEvent({ type: 'mouseUp', x: vpTo.x, y: vpTo.y, button: 'left', clickCount: 1 })
      // ★ 安全验证：检查 noVNC 内部 _mouseButtonMask 是否已清零
      win.webContents.executeJavaScript(`
        (function() {
          var c = document.getElementById('screen');
          if (!c) { console.log('[DRAG-CHECK] no #screen element'); return; }
          var canvas = c.querySelector('canvas');
          if (!canvas) { console.log('[DRAG-CHECK] no canvas'); return; }
          // 检查 capture proxy 是否存在
          var proxy = document.getElementById('noVNC_mouse_capture_elem');
          console.log('[DRAG-CHECK] proxy exists=' + !!proxy + ' display=' + (proxy ? proxy.style.display : 'N/A'));
          console.log('[DRAG-CHECK] captureElement=' + !!document.captureElement);
          // 检查 setCapture 是否被禁用
          console.log('[DRAG-CHECK] setCapture overridden=' + (Element.prototype.setCapture.toString().indexOf('native') === -1));
        })()
      `).catch(() => {})
      state.resolved = true
      if (_dragState[winIdx] === state) delete _dragState[winIdx]
      if (state.resolve) state.resolve()
    }, duration + hold))

    return
  }

  // ★★★ 滚轮事件 ★★★
  if (action === 'scroll') {
    cancelDrag(winIdx)
    const scrollX = x || 0
    const scrollY = y || 0
    const clampedX = Math.max(0, Math.min(scrollX, CLIENT_WIDTH - 1))
    const clampedY = Math.max(0, Math.min(scrollY, CLIENT_HEIGHT - 1))
    const vp = apiToViewport(clampedX, clampedY, win)
    const stepsY = Math.abs(deltaY || 0)
    const stepsX = Math.abs(deltaX || 0)
    const dirY = (deltaY || 0) > 0 ? -1 : 1  // API正(下)→Electron负
    const dirX = (deltaX || 0) > 0 ? -1 : 1
    const STEP_PX = 55
    for (let i = 0; i < stepsY; i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: vp.x, y: vp.y, deltaX: 0, deltaY: dirY * STEP_PX, canScroll: true })
    }
    for (let i = 0; i < stepsX; i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: vp.x, y: vp.y, deltaX: dirX * STEP_PX, deltaY: 0, canScroll: true })
    }
    return
  }

  // ★★★ 鼠标点击事件 ★★★
  const apiX = x || 0
  const apiY = y || 0

  // ★ 越界检查：API坐标基于客户端 856×480
  if (apiX < 0 || apiX >= CLIENT_WIDTH || apiY < 0 || apiY >= CLIENT_HEIGHT) return

  // ★ 纯数学算viewport，不需要canvas缓存
  const vp = apiToViewport(apiX, apiY, win)

  // ★ click/右键：先中断该窗口未完成的 drag，确保左键释放，再执行
  cancelDrag(winIdx)

  // ★★★ 左键弹起 ★★★ 单独释放左键，用于 drag 后左键卡住时手动调用
  if (action === 'release') {
    cancelDrag(winIdx)
    win.webContents.sendInputEvent({ type: 'mouseUp', x: vp.x, y: vp.y, button: 'left', clickCount: 1 })
    win.webContents.executeJavaScript(`
      (function() {
        var c = document.getElementById('screen');
        if (!c) return;
        var canvas = c.querySelector('canvas');
        if (!canvas) return;
        var rect = canvas.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        canvas.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, cancelable: true,
          clientX: cx, clientY: cy,
          button: 0, buttons: 0
        }));
        if (document.captureElement) document.captureElement = null;
        var proxy = document.getElementById('noVNC_mouse_capture_elem');
        if (proxy) proxy.style.display = 'none';
        console.log('[RELEASE] left button released at canvas center (' + cx + ',' + cy + ')');
      })()
    `).catch(() => {})
    return
  }

  if (action === 'click') {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: vp.x, y: vp.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: vp.x, y: vp.y, button: 'left', clickCount: 1 })
  } else if (action === 'rightclick') {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: vp.x, y: vp.y, button: 'right', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: vp.x, y: vp.y, button: 'right', clickCount: 1 })
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

  // ★ 读取命令行参数 --delay=毫秒，设置窗口创建间隔，默认0(同时创建)
  // 用法: novnc-cef-client.exe --delay=1500
  const delayArg = process.argv.find(a => a.startsWith('--delay='))
  const windowDelay = delayArg ? parseInt(delayArg.split('=')[1]) || 0 : 0
  console.log(`窗口创建间隔: ${windowDelay}ms` + (windowDelay > 0 ? ' (逐个创建)' : ' (同时创建)'))
  console.log(`启动模式: OSR离屏渲染 + 自建辅助窗口 (GPU加速+限帧15fps，大漠绑定辅助窗口)`)

  function createOneWindow(item, i) {
    const col = i % cols, row = Math.floor(i / cols)
    const x = offsetX + col * winW, y = row * winH

    // ========== 第1步：创建OSR离屏浏览器窗口 ==========
    // 无任何可见Win32窗口、不接入DWM桌面合成
    const osrWin = new BrowserWindow({
      x: -9999, y: -9999,  // 移出屏幕
      width: winW, height: winH,
      offscreen: true,     // ★ 纯离屏渲染，不创建可视桌面窗口
      show: false,
      frame: false,
      transparent: false,  // 禁止透明分层（OSR本身不需要）
      webPreferences: {
        hardwareAcceleration: true,
        webgl: true,
        backgroundThrottling: false,  // 禁止Electron后台冻结、降频、休眠页面
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    // ★ 关键：限制OSR最大渲染帧率 10~20fps
    if (osrWin.webContents.setFrameRate) {
      osrWin.webContents.setFrameRate(OSR_FRAME_RATE)
    }

    osrWin.setMenu(null)

    // ★ 键盘同步捕获（从OSR窗口捕获，转发到辅助窗口的输入）
    osrWin.webContents.on('before-input-event', (event, input) => {
      if (!controlMode) return
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return
      const si = osrWindows.indexOf(osrWin)
      if (si === -1) return
      forwardKeyEvent(si, {
        type: 'sync-key',
        eventType: input.type === 'keyDown' ? 'keydown' : 'keyup',
        key: input.key,
        code: input.code
      })
    })

    osrWin.webContents.on('did-finish-load', () => {
      // ★ 刷新 canvas 信息缓存（从OSR窗口获取）
      refreshCanvasInfo(osrWin, i)
      setTimeout(() => refreshCanvasInfo(osrWin, i), 2000)
      setTimeout(() => refreshCanvasInfo(osrWin, i), 5000)

      // ★ 禁用 noVNC 的 setCapture 机制
      osrWin.webContents.executeJavaScript(`
        (function() {
          var screen = document.getElementById('screen');
          if (!screen) return;
          screen.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            e.stopPropagation();
          }, true);

          var origSetCapture = Element.prototype.setCapture;
          Element.prototype.setCapture = function() {};

          if (document.captureElement !== undefined) {
            Object.defineProperty(document, 'captureElement', {
              get: function() { return null; },
              set: function() {}
            });
          }
        })()
      `).catch(() => {})
    })

    // ★ 调试：监听加载状态
    osrWin.webContents.on('did-start-loading', () => {
      console.log(`[窗口 ${i + 1}] 开始加载: ${item.url}`)
    })

    osrWin.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      console.log(`[窗口 ${i + 1}] 加载失败: ${errorCode} - ${errorDescription}`)
      console.log(`[窗口 ${i + 1}] URL: ${validatedURL}`)
    })

    osrWin.webContents.on('ready-to-show', () => {
      console.log(`[窗口 ${i + 1}] 页面准备显示`)
    })

    osrWin.loadURL(item.url)
    osrWindows.push(osrWin)

    // ========== 第2步：创建自建辅助窗口 ==========
    // 独立创建标准普通Win32隐藏窗口，不透明、不分层、不透明穿透
    // 拥有正常Windows窗口句柄，正常参与DWM标准缓冲合成
    const auxWin = new BrowserWindow({
      x, y, width: winW, height: winH,
      show: true,            // ★ 默认显示（大漠需要绑定这些窗口）
      frame: false,          // 无边框
      transparent: false,    // ★ 关键：禁止透明分层，保证DWM标准合成缓冲
      backgroundColor: '#000000',
      resizable: false,
      title: item.title
    })

    // ★ 禁止鼠标穿透，维持标准窗口属性
    auxWin.setIgnoreMouseEvents(true)  // 辅助窗口仅供大漠抓图，禁止鼠标交互

    auxWin.setMenu(null)
    auxWin.on('page-title-updated', (event) => { event.preventDefault(); auxWin.setTitle(item.title) })

    // ====== 第3步：使用定期截图绘制到辅助窗口 ======
    // ★ 关键：OSR 模式下 paint 事件不触发 canvas 内容，必须使用 capturePage
    // 每隔 OSR_FRAME_INTERVAL (67ms) 截图一次，即 15fps
    console.log(`[窗口 ${i + 1}] 启动定期截图任务 (${1000/OSR_FRAME_INTERVAL}fps)`)
    
    const captureInterval = setInterval(() => {
      // 限帧：检查距离上次绘制是否超过间隔时间
      const now = Date.now()
      const lastDrawTime = windowDrawTimes[i] || 0
      if (now - lastDrawTime < OSR_FRAME_INTERVAL) return
      
      windowDrawTimes[i] = now
      
      // 调用 capturePage 截取 OSR 窗口内容
      osrWin.webContents.capturePage().then(nativeImage => {
        if (!nativeImage) {
          if (enableOsrLogging) console.log(`[OSR] 窗口 ${i + 1}] capturePage 返回空图像`)
          return
        }
        
        if (enableOsrLogging) console.log(`[OSR] 窗口 ${i + 1}] capturePage 成功，尺寸: ${nativeImage.getSize().width}x${nativeImage.getSize().height}`)
        
        try {
          // 尝试加载native模块（仅在Windows平台有效）
          let drawBitmapToWindow = null

          // 只在Windows平台尝试加载native模块
          if (process.platform === 'win32') {
            try {
              let osrHelperPath
              // 尝试多个可能的路径
              try {
                osrHelperPath = path.join(__dirname, 'build', 'Release', 'osr_helper.node')
                const osrHelper = require(osrHelperPath)
                drawBitmapToWindow = osrHelper.drawBitmapToWindow
              } catch (e1) {
                try {
                  osrHelperPath = path.join(app.getAppPath(), 'build', 'Release', 'osr_helper.node')
                  const osrHelper = require(osrHelperPath)
                  drawBitmapToWindow = osr_helper.drawBitmapToWindow
                } catch (e2) {
                  if (enableOsrLogging) console.log(`[OSR] 窗口 ${i + 1}] native模块加载失败，跳过绘制 (${e1.message})`)
                  return
                }
              }
              if (enableOsrLogging) console.log(`[OSR] 窗口 ${i + 1}] native模块加载成功 (${osrHelperPath})`)
            } catch (e) {
              if (enableOsrLogging) console.log(`[OSR] 窗口 ${i + 1}] native模块加载失败，跳过绘制 (${e.message})`)
              return
            }
          } else {
            // 非Windows平台不支持native模块
            if (i === 0 && enableOsrLogging) {  // 只输出一次警告
              console.log('[OSR] 非Windows平台，native模块不可用，跳过OSR绘制功能')
            }
            return
          }

          if (!drawBitmapToWindow) return

          // 转换NativeImage为Buffer
          const bitmapBuffer = nativeImage.toBitmap()
          if (!bitmapBuffer || bitmapBuffer.length === 0) {
            if (enableOsrLogging) console.log(`[OSR] 窗口 ${i + 1}] bitmapBuffer 为空，跳过绘制`)
            return
          }

          // 获取辅助窗口句柄
          const hwndBuf = auxWin.getNativeWindowHandle()
          let hwnd
          if (hwndBuf.length === 8) {
            const lo = hwndBuf.readUInt32LE(0), hi = hwndBuf.readUInt32LE(4)
            hwnd = hi === 0 ? lo : Number(hwndBuf.readBigUInt64LE())
          } else {
            hwnd = hwndBuf.readUInt32LE(0)
          }

          if (enableOsrLogging) console.log(`[OSR] 窗口 ${i + 1}] 开始绘制到辅助窗口 HWND=${hwnd}, bitmapBuffer.size=${bitmapBuffer.length}`)
          
          // 通过GDI绘制到辅助窗口
          drawBitmapToWindow(hwnd, winW, winH, bitmapBuffer)
          if (enableOsrLogging) console.log(`[OSR] 窗口 ${i + 1}] 绘制完成`)
        } catch (e) {
          if (enableOsrLogging) console.error(`[OSR] 窗口 ${i + 1} 绘制失败:`, e.message)
        }
      }).catch(err => {
        if (enableOsrLogging) console.error(`[OSR] 窗口 ${i + 1}] capturePage 失败:`, err.message)
      })
    }, OSR_FRAME_INTERVAL)
    
    // 保存定时器引用，方便后续清理
    osrWin.captureInterval = captureInterval

    vncWindows.push(auxWin)

    // ========== 第4步：延迟输出窗口信息（输出辅助窗口的HWND）==========
    setTimeout(() => {
      const hwndBuf = auxWin.getNativeWindowHandle()
      let hwndDec
      if (hwndBuf.length === 8) {
        const lo = hwndBuf.readUInt32LE(0), hi = hwndBuf.readUInt32LE(4)
        hwndDec = hi === 0 ? lo : Number(hwndBuf.readBigUInt64LE())
      } else {
        hwndDec = hwndBuf.readUInt32LE(0)
      }

      // ★ 格式化输出：窗口序号 | 窗口标题 | 句柄(10进制，大漠绑定格式)
      console.log(`窗口 ${i + 1}: 标题="${item.title}" HWND=${hwndDec}`)
    }, 1000)

    return { osrWin, auxWin }
  }

  if (windowDelay > 0) {
    // ★ 有间隔：逐个创建，每个间隔 windowDelay 毫秒
    function createNextWindow(i) {
      if (i >= groupItems.length) {
        createControlButtons(vncWindows[0] || null, groupItems.length)
        if (!apiServer) startAPIServer(groupIndex, config)
        return
      }
      createOneWindow(groupItems[i], i)
      if (i === groupItems.length - 1) {
        // 最后一个窗口创建完后，等间隔再初始化控制栏
        setTimeout(() => {
          createControlButtons(vncWindows[0] || null, groupItems.length)
          if (!apiServer) startAPIServer(groupIndex, config)
        }, windowDelay)
      } else {
        setTimeout(() => createNextWindow(i + 1), windowDelay)
      }
    }
    createNextWindow(0)
  } else {
    // ★ 无间隔：同时创建所有窗口
    groupItems.forEach((item, i) => {
      createOneWindow(item, i)
    })
    createControlButtons(vncWindows[0] || null, groupItems.length)
    if (!apiServer) startAPIServer(groupIndex, config)
  }
}


app.whenReady().then(() => {
  const config = readConfig()
  if (!config) {
    showStartupError('配置文件加载失败', `程序没有退出，但未能读取配置。\n\n请确认 配置文件.int 位于 exe 同目录，或使用 --config=完整路径 指定。\n\n日志位置优先为 exe 同目录 Log.txt，无法写入时在 ${app.getPath('userData')}\Log.txt`)
    return
  }
  if (config.groups.length === 0) {
    showStartupError('配置异常', '未找到分组信息。请检查 配置文件.int 中是否存在 组1名称、组2名称 等字段。')
    return
  }
  // 从配置文件读取 OSR 日志开关（优先级高于命令行参数）
  if (config.osrLogEnabled !== undefined) {
    enableOsrLogging = config.osrLogEnabled
    console.log(`[配置] OSR日志: ${enableOsrLogging ? '开启' : '关闭'} (来源: 配置文件)`)
  } else {
    console.log(`[配置] OSR日志: ${enableOsrLogging ? '开启' : '关闭'} (来源: 命令行参数 ${enableOsrLogging ? '--osr-logs' : '默认'})`)
  }
  if (config.groups.length === 1) createVNCWindows(config, config.groups[0].index)
  else showGroupSelector(config)
  app.on('activate', () => {})
})

ipcMain.on('select-group', (event, groupIndex) => {
  const config = readConfig()
  if (selectWindow && !selectWindow.isDestroyed()) selectWindow.close()
  if (config) createVNCWindows(config, groupIndex)
})

// ★ 控制模式切换：点击右下角"控制"按钮
ipcMain.on('toggle-control', (event, enabled) => {
  controlMode = enabled
  if (enabled) {
    // 开启控制模式：解除辅助窗口鼠标限制，显示刷新按钮
    vncWindows.forEach(w => w.setIgnoreMouseEvents(false))
    console.log('控制模式开启：辅助窗口鼠标限制已解除')
    // 显示每个辅助窗口的刷新按钮
    showRefreshButtons()
  } else {
    // 关闭控制模式：恢复辅助窗口鼠标限制，隐藏刷新按钮
    vncWindows.forEach(w => w.setIgnoreMouseEvents(true))
    console.log('控制模式关闭：辅助窗口鼠标限制已恢复')
    // 隐藏所有刷新按钮
    hideRefreshButtons()
  }
})

// ========== 显示/隐藏辅助窗口刷新按钮 ==========
function showRefreshButtons () {
  const apiPort = 38980 + currentGroupIndex
  console.log(`开始显示刷新按钮，共 ${vncWindows.length} 个辅助窗口`)
  
  vncWindows.forEach((auxWin, i) => {
    try {
      if (!auxWin || auxWin.isDestroyed()) {
        console.log(`跳过窗口 ${i + 1}：窗口不存在或已销毁`)
        return
      }
      
      const bounds = auxWin.getBounds()
      const windowIndex = i + 1
      console.log(`创建窗口 ${windowIndex} 的刷新按钮，位置：${bounds.x + bounds.width - 60}, ${bounds.y + bounds.height - 40}`)
      
    // 创建刷新按钮窗口（浮动，置顶，作为辅助窗口的子窗口）
    const refreshBtn = new BrowserWindow({
      x: bounds.x + bounds.width - 60,
      y: bounds.y + bounds.height - 40,
      width: 56,
      height: 32,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,  // 禁用窗口阴影，去除灰色边框
      parent: auxWin,   // 设置为辅助窗口的子窗口，跟随辅助窗口
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    })
    
    refreshBtn.setMenu(null)
    
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:56px;height:32px;background:transparent;overflow:hidden;display:flex;justify-content:center;align-items:center}button{width:50px;height:28px;padding:0;background:#007bff;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;font-family:"Microsoft YaHei",sans-serif;box-shadow:0 2px 4px rgba(0,0,0,0.3);outline:none}button:hover{background:#0069d9;box-shadow:0 3px 6px rgba(0,0,0,0.4)}button:active{background:#0056b3;box-shadow:0 1px 2px rgba(0,0,0,0.3)}button:focus{outline:none}</style></head><body><button onclick="refreshWindow()">刷新</button><script>const{ipcRenderer}=require('electron');function refreshWindow(){const btn=document.querySelector('button');btn.textContent='...';fetch('http://127.0.0.1:${apiPort}/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({windowIndex:${windowIndex}})}).then(res=>res.text()).then(text=>{btn.textContent='√';setTimeout(()=>btn.textContent='刷新',1000)}).catch(err=>{console.error('刷新失败:',err);btn.textContent='×';setTimeout(()=>btn.textContent='刷新',1000)})}</script></body></html>`
      
      refreshBtn.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      
      // 窗口关闭时清理
      refreshBtn.on('closed', () => {
        const idx = refreshBtnWindows.indexOf(refreshBtn)
        if (idx !== -1) refreshBtnWindows.splice(idx, 1)
      })
      
      refreshBtnWindows.push(refreshBtn)
      console.log(`窗口 ${windowIndex} 刷新按钮已显示`)
    } catch (err) {
      console.error(`创建窗口 ${i + 1} 刷新按钮失败:`, err && (err.message || err))
    }
  })
  
  console.log(`刷新按钮显示完成，共创建 ${refreshBtnWindows.length} 个按钮`)
}

function hideRefreshButtons () {
  console.log(`开始隐藏刷新按钮，当前有 ${refreshBtnWindows.length} 个按钮`)
  
  // 使用 while 循环避免 forEach 中修改数组的问题
  while (refreshBtnWindows.length > 0) {
    const btn = refreshBtnWindows.shift()  // 取出第一个
    if (!btn) continue
    
    try {
      if (!btn.isDestroyed()) {
        btn.destroy()
        console.log('已销毁一个刷新按钮')
      } else {
        console.log('按钮已销毁，跳过')
      }
    } catch (err) {
      console.error('销毁刷新按钮失败:', err && (err.message || err))
    }
  }
  
  refreshBtnWindows = []
  console.log('所有刷新按钮已隐藏')
}

ipcMain.on('exit-app', () => {
  // 清除所有 capturePage 定时器
  osrWindows.forEach(w => {
    if (w && w.captureInterval) {
      clearInterval(w.captureInterval)
      w.captureInterval = null
    }
  })
  
  // 关闭所有 OSR 窗口
  osrWindows.forEach(w => { try { w.destroy() } catch (e) {} })
  osrWindows.length = 0
  
  // 关闭所有辅助窗口（vncWindows 就是辅助窗口数组）
  vncWindows.forEach(w => { try { w.destroy() } catch (e) {} })
  vncWindows.length = 0
  
  // 关闭控制栏
  if (controlBarWindow) { try { controlBarWindow.destroy() } catch (e) {} controlBarWindow = null }
  
  // 关闭 API 服务器
  if (apiServer) { try { apiServer.close() } catch (e) {} apiServer = null }
  
  // 退出应用
  app.quit()
  process.exit(0)
})
app.on('window-all-closed', () => {})
