const { ipcRenderer, contextBridge } = require('electron')

// 暴露同步事件接口给页面
contextBridge.exposeInMainWorld('electronSync', {
  send: (data) => ipcRenderer.send('vnc-sync-event', data),
  isEnabled: () => ipcRenderer.sendSync('vnc-sync-check')
})
