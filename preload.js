// preload.js - 劫持WebSocket捕获VNC连接，用于API直接发送VNC协议事件
const { ipcRenderer } = require('electron')

// ★ 劫持WebSocket，捕获所有VNC连接
const OrigWebSocket = window.WebSocket
const _vncSockets = []
window.__vncSockets = _vncSockets

window.WebSocket = function(url, protocols) {
  const ws = new OrigWebSocket(url, protocols)
  // 检测VNC连接（通过ws或wss协议，或特定端口）
  if (url && (url.startsWith('ws://') || url.startsWith('wss://'))) {
    _vncSockets.push(ws)
    console.log('[preload] VNC WebSocket captured:', url)
    ws.addEventListener('close', () => {
      const idx = _vncSockets.indexOf(ws)
      if (idx !== -1) _vncSockets.splice(idx, 1)
    })
  }
  return ws
}
// 继承原型链
window.WebSocket.prototype = OrigWebSocket.prototype
window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING
window.WebSocket.OPEN = OrigWebSocket.OPEN
window.WebSocket.CLOSING = OrigWebSocket.CLOSING
window.WebSocket.CLOSED = OrigWebSocket.CLOSED

// ★ 提供直接发送VNC指针事件的函数
window.__sendVNCPointer = function(sockIdx, x, y, mask) {
  const ws = _vncSockets[sockIdx]
  if (!ws || ws.readyState !== OrigWebSocket.OPEN) {
    return 'NO_SOCK'
  }
  // VNC PointerEvent: msg-type=5, mask, x(16bit BE), y(16bit BE)
  const buf = new Uint8Array(6)
  buf[0] = 5    // msg-type
  buf[1] = mask // button mask
  buf[2] = (x >> 8) & 0xFF  // x high byte
  buf[3] = x & 0xFF         // x low byte
  buf[4] = (y >> 8) & 0xFF  // y high byte
  buf[5] = y & 0xFF         // y low byte
  ws.send(buf)
  return 'OK'
}

console.log('[preload] WebSocket hijack installed')
