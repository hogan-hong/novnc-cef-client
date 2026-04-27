const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const http = require('http')
const WebSocket = require('ws')

// ========== 日志写入同目录Log.txt（异步缓冲，避免磁盘IO阻塞）==========
const logPath = path.join(path.dirname(app.getPath('exe')), 'Log.txt')
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
  // 异步写磁盘，不阻塞
  fs.writeFile(logPath, data, { flag: 'a', encoding: 'utf-8' }, () => {})
}
console.log = function () { writeLog([...arguments].map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); origLog.apply(console, arguments) }
console.error = function () { writeLog('ERR: ' + [...arguments].map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); origErr.apply(console, arguments) }
// 启动时清空旧日志
try { fs.writeFileSync(logPath, `[${new Date().toLocaleString('zh-CN', {hour12:false})}] === NoVNC Client 启动 ===\n`, 'utf-8') } catch (e) {}

// ========== 禁用 DirectComposition，保证GDI截图不黑屏 ==========
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

// ========== 全局状态 ==========
let syncEnabled = false
let currentGroupIndex = 1
const vncWindows = []
let apiServer = null
let exitWindow = null
let selectWindow = null

// ★ 主控窗口索引，只有主控窗口的输入会同步到其他窗口
let masterWindowIndex = 0

// ★ Canvas 信息缓存：每个窗口的 canvas 尺寸和位置
const canvasInfoCache = {}

// ========== 读取配置文件 ==========
function readConfig () {
  const configPath = path.join(path.dirname(app.getPath('exe')), '配置文件.int')
  if (!fs.existsSync(configPath)) {
    require('electron').dialog.showErrorBox('配置文件不存在', `未找到配置文件！\n路径: ${configPath}\n请将 配置文件.int 放在exe同目录下`)
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
      const vu = content.match(new RegExp(`videourl${i}=(.+)`, 'm'))
      if (u && u[1].trim()) {
        const url = u[1].trim()
        // 如果没配 videourl，自动从 URL 生成：vnc_lite → vnc_video
        let videoUrl = vu ? vu[1].trim() : url.replace(/vnc_lite/, 'vnc_video').replace(/vnc_run/, 'vnc_video')
        config.items.push({ index: i, url, videoUrl, title: t ? t[1].trim() : `窗口${i}`, controlIP: ip ? ip[1].trim() : '' })
      }
    }
    if (config.groups.length === 0) {
      require('electron').dialog.showErrorBox('配置异常', `未找到分组信息！\n请检查 配置文件.int 中的 组1名称 等字段`)
      return null
    }
    return config
  } catch (e) {
    require('electron').dialog.showErrorBox('读取配置文件失败', `文件: ${configPath}\n错误: ${e.message}`)
    return null
  }
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
  selectWindow = new BrowserWindow({ width: 520, height: 120 + config.groups.length * 70, frame: true, title: 'NoVNC 群控 - 选择分组', resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  selectWindow.setMenu(null)
  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;padding:20px}h2{text-align:center;margin-bottom:18px;color:#e94560;font-size:18px}.group-btn{display:block;width:100%;padding:14px;margin-bottom:12px;font-size:16px;font-weight:bold;color:#fff;background:#16213e;border:2px solid #e94560;border-radius:8px;cursor:pointer}.group-btn:hover{background:#e94560}</style></head><body><h2>选择要启动的分组</h2>`
  config.groups.forEach((g) => { const s = (g.index - 1) * 5 + 1, e = g.index * 5; html += `<button class="group-btn" onclick="selectGroup(${g.index})">控制 ${g.name} 组（编号 ${s}-${e}）</button>\n` })
  html += `<script>const{ipcRenderer}=require('electron');function selectGroup(i){ipcRenderer.send('select-group',i)}</script></body></html>`
  selectWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ========== 右下角控制按钮 ==========
function createControlButtons (parentWin) {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  exitWindow = new BrowserWindow({ x: workArea.width - 130, y: workArea.height - 40, width: 120, height: 30, frame: false, transparent: true, parent: parentWin, alwaysOnTop: false, skipTaskbar: true, resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  exitWindow.setMenu(null)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:transparent;width:120px;height:30px;display:flex;gap:2px}button{width:59px;height:30px;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;font-family:"Microsoft YaHei",sans-serif}#syncBtn{background:#28a745}#syncBtn:hover{background:#218838}#syncBtn.active{background:#dc3545}#syncBtn.active:hover{background:#c82333}#exitBtn{background:#e94560}#exitBtn:hover{background:#c23152}</style></head><body><button id="syncBtn" onclick="toggleSync()">同步</button><button id="exitBtn" onclick="quit()">退出</button><script>const{ipcRenderer}=require('electron');let s=false;function toggleSync(){s=!s;const b=document.getElementById('syncBtn');if(s){b.textContent='关闭同步';b.classList.add('active')}else{b.textContent='同步';b.classList.remove('active')}ipcRenderer.send('toggle-sync',s)}function quit(){ipcRenderer.send('exit-app')}</script></body></html>`
  exitWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ========== 主控按钮：在每个VNC窗口内注入/移除 ==========
// ★★★ 同步事件捕获注入（按需注入，关闭同步时移除）★★★
function injectSyncCapture () {
  const apiPort = 38980 + currentGroupIndex
  vncWindows.forEach((win, i) => {
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

function injectMasterButtons () {
  vncWindows.forEach((win, i) => {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      (function() {
        // 避免重复注入：已有按钮时显示并更新样式
        var existingBtn = document.getElementById('__novnc_master_btn');
        if (existingBtn) {
          existingBtn.style.display = 'block';
          existingBtn.style.background = ${i} === ${masterWindowIndex} ? '#28a745' : '#555';
          existingBtn.textContent = ${i} === ${masterWindowIndex} ? '主控✓' : '主控';
          return;
        }
        var btn = document.createElement('div');
        btn.id = '__novnc_master_btn';
        btn.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:999999;padding:4px 10px;' +
          'border-radius:4px;color:#fff;font-size:12px;font-weight:bold;font-family:"Microsoft YaHei",sans-serif;' +
          'cursor:pointer;user-select:none;opacity:0.85;transition:opacity 0.2s;' +
          'background:' + (${i} === ${masterWindowIndex} ? "'#28a745'" : "'#555'") + ';';
        btn.textContent = ${i} === ${masterWindowIndex} ? '主控✓' : '主控';
        btn.addEventListener('mouseenter', function(){ btn.style.opacity = '1'; });
        btn.addEventListener('mouseleave', function(){ btn.style.opacity = '0.85'; });
        // 点击切换主控，阻止事件冒泡到 #screen 的同步捕获
        btn.addEventListener('mousedown', function(e){ e.stopPropagation(); e.preventDefault(); }, true);
        btn.addEventListener('mouseup', function(e){ e.stopPropagation(); }, true);
        btn.addEventListener('click', function(e){
          e.stopPropagation();
          e.preventDefault();
          try {
            fetch('http://127.0.0.1:${38980 + currentGroupIndex}/set-master', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ windowIndex: ${i} })
            }).catch(function(){});
          } catch(ex) {}
        }, true);
        document.body.appendChild(btn);
      })()
    `).catch(() => {})
  })
}

function removeMasterButtons () {
  vncWindows.forEach((win) => {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      var btn = document.getElementById('__novnc_master_btn');
      if (btn) btn.style.display = 'none';
    `).catch(() => {})
  })
}

function updateMasterButtons () {
  vncWindows.forEach((win, i) => {
    if (!win || win.isDestroyed()) return
    const isMaster = i === masterWindowIndex
    win.webContents.executeJavaScript(`
      var btn = document.getElementById('__novnc_master_btn');
      if (btn) {
        btn.style.background = ${isMaster} ? '#28a745' : '#555';
        btn.textContent = ${isMaster} ? '主控✓' : '主控';
      }
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
  const vpX = Math.round(apiX * (PHONE_WIDTH / CLIENT_WIDTH) * scale + (winW - PHONE_WIDTH * scale) / 2)
  const vpY = Math.round(apiY * (PHONE_HEIGHT / CLIENT_HEIGHT) * scale + (winH - PHONE_HEIGHT * scale) / 2)
  return { x: vpX, y: vpY }
}

// ★★★ 同步核心逻辑 — sendInputEvent + 主控切换 ★★★
// 只有主控窗口 (masterWindowIndex) 的输入会同步到其他窗口
// 其他窗口可以正常单独操作，不会影响别的窗口

// ========== 同步：转发鼠标事件到其他窗口 ==========
function forwardMouseEvent (sourceIdx, data) {
  if (!syncEnabled) return
  if (sourceIdx !== masterWindowIndex) return

  const { eventType, x: vncX, y: vncY, button } = data

  vncWindows.forEach((win, i) => {
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
  if (!syncEnabled) return
  if (sourceIdx !== masterWindowIndex) return

  vncWindows.forEach((win, i) => {
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
  if (!syncEnabled) return
  if (sourceIdx !== masterWindowIndex) return

  vncWindows.forEach((win, i) => {
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

    // ★ 设置主控窗口
    if (req.method === 'POST' && req.url === '/set-master') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const newMaster = data.windowIndex
          if (newMaster >= 0 && newMaster < vncWindows.length) {
            masterWindowIndex = newMaster
            updateMasterButtons()
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end('{"ok":false}')
        }
      })
      return
    }

    // ★ 同步事件接收
    if (req.method === 'POST' && req.url === '/sync') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const si = data.sourceIndex !== undefined ? data.sourceIndex : -1
          if (si >= 0) {
            if (data.type === 'sync-mouse') forwardMouseEvent(si, data)
            else if (data.type === 'sync-key') forwardKeyEvent(si, data)
            else if (data.type === 'sync-wheel') forwardWheelEvent(si, data)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (e) {
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
      const diagIdx = parseInt(urlObj.searchParams.get('win') || '0')
      const diagWin = vncWindows[diagIdx]
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
      const devIdx = parseInt(urlObj.searchParams.get('win') || '0')
      const devWin = vncWindows[devIdx]
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
      res.end(JSON.stringify({ success: true, windowCount: vncWindows.length, sync: syncEnabled, master: masterWindowIndex, port }))
      return
    }
    res.writeHead(404); res.end('Not Found')
  })
  // ★ 屏幕墙改用 iframe 直连 vnc_video.html，替代 WebSocket 截图推流
  // 不再需要 wss.on('connection')，屏幕墙页面自己连 VNC
  const wss = new WebSocket.Server({ server })
  wss.on('connection', (ws) => {
    // 兼容：如果老版本屏幕墙连过来，返回空避免报错
    ws.on('message', () => {})
    ws.close()
  })

  server.listen(port, '0.0.0.0', () => console.log(`API + Sync + WS on http://0.0.0.0:${port}`))
  apiServer = server

  // ★ 屏幕墙服务：自动发现所有已启动的客户端，汇总它们的 videourl
  startOverviewServer(config)
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
    const win = vncWindows[winIdx]
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
  const { action } = data
  if (action.endsWith('All')) {
    let count = 0
    vncWindows.forEach((w, i) => { if (w && !w.isDestroyed()) { sendToVNC(i, data); count++ } })
    return `Sent to ${count} windows`
  }
  const idx = data.windowIndex || 0
  const win = vncWindows[idx]
  if (!win || win.isDestroyed()) throw new Error(`Window ${idx} not found`)
  sendToVNC(idx, data)
  return `Sent to window ${idx}`
}

// ★★★ sendToVNC: API控制 → VNC窗口 ★★★
// 固定横屏 856×480 → 1334×750，纯数学算viewport，不依赖canvas缓存
function sendToVNC (winIdx, data) {
  const win = vncWindows[winIdx]
  if (!win || win.isDestroyed()) return
  const { action, x, y, deltaY, deltaX, text, code, down } = data

  // 剪贴板走executeJavaScript
  if (action === 'clipboard' || action === 'clipboardAll') {
    win.webContents.executeJavaScript(`
      (function(){
        var r = window.__rfb;
        if(r && r.clipboardPasteFrom) { r.clipboardPasteFrom(${JSON.stringify(text || '')}); return; }
      })()
    `).catch(() => {})
    return
  }

  // 键盘走sendInputEvent
  if (action === 'keypress' || action === 'keypressAll') {
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
  if (action === 'drag' || action === 'dragAll') {
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
      win.webContents.sendInputEvent({ type: 'mouseUp', x: vpTo.x, y: vpTo.y, button: 'left', clickCount: 1 })
      state.resolved = true
      if (_dragState[winIdx] === state) delete _dragState[winIdx]
      if (state.resolve) state.resolve()
    }, duration + hold))

    return
  }

  // ★★★ 滚轮事件 ★★★
  // NoVNC/VNC 协议只支持逐格滚动（按钮事件），没有连续滚动量
  // NoVNC 内部累积 deltaY，≥50px 触发一格滚动然后归零
  // 所以发一个大 delta 只会滚一格，多余的被丢弃
  // 正确做法：拆成多次小 delta 发送，每次 ≥50px 就触发一格
  if (action === 'scroll' || action === 'scrollAll') {
    cancelDrag(winIdx)
    const scrollX = x || 0
    const scrollY = y || 0
    const clampedX = Math.max(0, Math.min(scrollX, CLIENT_WIDTH - 1))
    const clampedY = Math.max(0, Math.min(scrollY, CLIENT_HEIGHT - 1))
    const vp = apiToViewport(clampedX, clampedY, win)
    // deltaY 正数=向下滚，负数=向上滚（API约定）
    // 绝对值=滚动格数，1=滚1格
    const stepsY = Math.abs(deltaY || 0)
    const stepsX = Math.abs(deltaX || 0)
    const dirY = (deltaY || 0) > 0 ? -1 : 1  // API正(下)→Electron负
    const dirX = (deltaX || 0) > 0 ? -1 : 1
    // 每次 mouseWheel 发送 55px 的 delta（NoVNC 阈值50px，留点余量）
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

  if (action === 'click' || action === 'clickAll') {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: vp.x, y: vp.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: vp.x, y: vp.y, button: 'left', clickCount: 1 })
  } else if (action === 'rightclick' || action === 'rightclickAll') {
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

  function createOneWindow(item, i) {
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

    // ★ 键盘同步捕获
    win.webContents.on('before-input-event', (event, input) => {
      if (!syncEnabled) return
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return
      const si = vncWindows.indexOf(win)
      if (si === -1) return
      forwardKeyEvent(si, {
        type: 'sync-key',
        eventType: input.type === 'keyDown' ? 'keydown' : 'keyup',
        key: input.key,
        code: input.code
      })
    })

    win.webContents.on('did-finish-load', () => {
      setTimeout(() => setLayer2Title(win, item), 500)

      // ★ 刷新 canvas 信息缓存
      refreshCanvasInfo(win, i)
      setTimeout(() => refreshCanvasInfo(win, i), 2000)
      setTimeout(() => refreshCanvasInfo(win, i), 5000)

      // ★ 只保留右键菜单拦截（轻量），同步捕获代码在开启同步时才注入
      win.webContents.executeJavaScript(`
        (function() {
          var screen = document.getElementById('screen');
          if (!screen) return;
          screen.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            e.stopPropagation();
          }, true);

          // ★ 禁用 noVNC 的 setCapture 机制
          // setCapture 会创建全屏透明 proxy 覆盖 canvas，导致 sendInputEvent 的
          // mouseUp 被 proxy 吞掉/重定向失败，VNC 侧左键一直按住不弹起
          // 禁用后 mouseUp 直接落在 canvas 上，noVNC 正确处理
          var origSetCapture = Element.prototype.setCapture;
          Element.prototype.setCapture = function() {
            // no-op：不允许 capture，避免 proxy 干扰 sendInputEvent
          };
          // 也禁用 document 级别的 capture polyfill
          if (document.captureElement !== undefined) {
            Object.defineProperty(document, 'captureElement', {
              get: function() { return null; },
              set: function() {}
            });
          }
        })()
      `).catch(() => {})
    })

    win.on('resize', () => refreshCanvasInfo(win, i))
    win.loadURL(item.url)
    vncWindows.push(win)
    return win
  }

  if (windowDelay > 0) {
    // ★ 有间隔：逐个创建，每个间隔 windowDelay 毫秒
    function createNextWindow(i) {
      if (i >= groupItems.length) {
        createControlButtons(vncWindows[0] || null)
        if (!apiServer) startAPIServer(groupIndex, config)
        return
      }
      createOneWindow(groupItems[i], i)
      if (i === groupItems.length - 1) {
        // 最后一个窗口创建完后，等间隔再初始化控制按钮
        setTimeout(() => {
          createControlButtons(vncWindows[0] || null)
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
    createControlButtons(vncWindows[0] || null)
    if (!apiServer) startAPIServer(groupIndex, config)
  }
}

// ========== 屏幕墙服务 (端口38988，自动接管) ==========
let overviewServer = null
let overviewCheckTimer = null
// ★ 屏幕墙收集的各组视频URL（由每个客户端进程注册）
let overviewVideoUrls = {}  // groupIndex -> [{index, videoUrl, title, controlIP}]
let overviewApiPort = null  // 本客户端的API端口，用于注册到屏幕墙

function startOverviewServer (config) {
  const OVERVIEW_PORT = 38988
  // ★ 本客户端注册自己的 videourl 到屏幕墙（如果自己就是屏幕墙主程序则直接写内存）
  registerVideoUrls(config)
  tryBindOverview(OVERVIEW_PORT, config)
  startOverviewWatchdog(OVERVIEW_PORT, config)
}

// ★ 注册本客户端的 videourl 到屏幕墙
function registerVideoUrls (config) {
  const startIdx = (currentGroupIndex - 1) * 5
  const groupItems = config.items.slice(startIdx, startIdx + 5)
  const myUrls = groupItems.map((item, i) => ({
    index: i,
    videoUrl: item.videoUrl,
    title: item.title,
    controlIP: item.controlIP,
    group: currentGroupIndex
  }))
  overviewVideoUrls[currentGroupIndex] = myUrls

  // ★ 如果屏幕墙主程序不是自己，通过HTTP注册
  if (!overviewServer) {
    setTimeout(() => {
      try {
        const regData = JSON.stringify({ group: currentGroupIndex, urls: myUrls })
        const req = http.request({
          hostname: '127.0.0.1', port: 38988, path: '/register',
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(regData) }
        }, () => {})
        req.on('error', () => {})
        req.write(regData)
        req.end()
      } catch (e) {}
    }, 1000)
  }
}

function tryBindOverview (port, config) {
  const testServer = require('net').createServer()
  testServer.on('error', () => {
    // 端口被占用，说明已有其他客户端在当屏幕墙主程序
    testServer.close()
  })
  testServer.listen(port, '0.0.0.0', () => {
    testServer.close(() => {
      // 端口空闲，启动屏幕墙
      overviewServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

        // ★ 接收其他客户端注册的 videourl
        if (req.method === 'POST' && req.url === '/register') {
          let body = ''
          req.on('data', chunk => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              overviewVideoUrls[data.group] = data.urls
              console.log(`[屏幕墙] 注册组${data.group}的${data.urls.length}个视频URL`)
            } catch (e) {}
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          })
          return
        }

        if (req.url === '/' || req.url === '/overview') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(buildOverviewHTML())
        } else {
          res.writeHead(404); res.end()
        }
      })
      overviewServer.listen(port, '0.0.0.0', () => {
        console.log(`[屏幕墙] 启动成功: http://0.0.0.0:${port}/overview`)
      })
      overviewServer.on('error', () => {
        // bind失败，被其他客户端抢先了
        overviewServer = null
      })
    })
  })
}

function startOverviewWatchdog (port, config) {
  if (overviewCheckTimer) clearInterval(overviewCheckTimer)
  overviewCheckTimer = setInterval(() => {
    // 如果自己就是屏幕墙主程序，不需要检测
    if (overviewServer) return
    // 检测38988是否存活
    const socket = new (require('net').Socket)()
    socket.setTimeout(1500)
    socket.on('connect', () => {
      // 端口还活着，注册自己的URL（屏幕墙可能重启了）
      socket.destroy()
      if (config) registerVideoUrls(config)
    })
    socket.on('error', () => {
      // 连不上，可能主程序挂了，尝试接管
      socket.destroy()
      tryBindOverview(port, config)
    })
    socket.on('timeout', () => {
      socket.destroy()
    })
    socket.connect(port, '127.0.0.1')
  }, 3000)
}

// ★ 动态生成屏幕墙 HTML（iframe 直连 vnc_video.html）
function buildOverviewHTML () {
  // 汇总所有已注册的视频URL
  const allItems = []
  const sortedGroups = Object.keys(overviewVideoUrls).sort((a, b) => a - b)
  sortedGroups.forEach(g => {
    overviewVideoUrls[g].forEach(item => {
      allItems.push(item)
    })
  })

  // 生成 iframe 片段
  let iframeParts = ''
  allItems.forEach((item, i) => {
    const label = item.controlIP || item.title || `窗口${i}`
    iframeParts += `
      <div class="cell">
        <div class="label">${label}</div>
        <iframe src="${item.videoUrl}" allow="autoplay"></iframe>
      </div>`
  })

  // 如果没有任何注册的URL，显示提示
  if (allItems.length === 0) {
    iframeParts = '<div class="empty">等待客户端注册...</div>'
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>NoVNC 屏幕墙</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;color:#eee;font-family:"Microsoft YaHei",sans-serif;overflow:hidden;height:100vh;width:100vw}
#grid{width:100%;height:100%;display:flex;flex-wrap:wrap;align-content:flex-start}
.cell{position:relative;background:#000;border:none;display:flex;align-items:center;justify-content:center;overflow:hidden}
.cell iframe{width:100%;height:100%;border:none}
.cell .label{position:absolute;top:2px;left:4px;font-size:11px;background:rgba(0,0,0,0.7);padding:1px 5px;border-radius:3px;color:#aaa;z-index:10;pointer-events:none}
.empty{text-align:center;padding-top:40vh;color:#666;font-size:16px}
</style></head><body>
<div id="grid">${iframeParts}</div>
<script>
// 自动布局：根据窗口数量调整每个cell的尺寸
function layoutGrid() {
  const cells = document.querySelectorAll('.cell')
  if (cells.length === 0) return
  const gW = window.innerWidth, gH = window.innerHeight
  const total = cells.length
  // 5列布局
  const cols = Math.min(5, total)
  const rows = Math.ceil(total / cols)
  const cellW = Math.floor(gW / cols)
  const cellH = Math.floor(gH / rows)
  cells.forEach(cell => {
    cell.style.width = cellW + 'px'
    cell.style.height = cellH + 'px'
  })
}
layoutGrid()
window.addEventListener('resize', layoutGrid)
// ★ 定时刷新页面获取最新注册的URL（每10秒）
setTimeout(() => { if (document.querySelectorAll('.cell iframe').length === 0) location.reload() }, 10000)
</script></body></html>`
}

app.whenReady().then(() => {
  const config = readConfig()
  if (!config) { app.quit(); return }
  if (config.groups.length === 0) { require('electron').dialog.showErrorBox('配置异常', '未找到分组信息！'); app.quit(); return }
  if (config.groups.length === 1) createVNCWindows(config, config.groups[0].index)
  else showGroupSelector(config)
  app.on('activate', () => {})
})

ipcMain.on('select-group', (event, groupIndex) => { const config = readConfig(); if (config) createVNCWindows(config, groupIndex) })
ipcMain.on('toggle-sync', (event, enabled) => {
  syncEnabled = enabled
  if (enabled) {
    vncWindows.forEach((w, i) => refreshCanvasInfo(w, i))
    injectSyncCapture()
    setTimeout(() => {
      injectMasterButtons()
      updateMasterButtons()
    }, 300)
  } else {
    removeSyncCapture()
    removeMasterButtons()
  }
  console.log(`Sync ${enabled ? 'ON' : 'OFF'}`)
})
ipcMain.on('exit-app', () => {
  vncWindows.forEach(w => { try { w.destroy() } catch (e) {} }); vncWindows.length = 0
  if (exitWindow) { try { exitWindow.destroy() } catch (e) {} exitWindow = null }
  if (apiServer) { try { apiServer.close() } catch (e) {} apiServer = null }
  if (overviewServer) { try { overviewServer.close() } catch (e) {} overviewServer = null }
  app.quit(); process.exit(0)
})
app.on('window-all-closed', () => {})
