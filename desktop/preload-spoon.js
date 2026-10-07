// preload-spoon.js — 스푼 방송 창용.
// 사운드 엔진(broadcast_inject.js)은 녹음 조각을 저장하려고 window.require('electron').ipcRenderer.send('bcast:rec', ...)
// 를 쓴다. 스푼 웹 페이지에 Node 전체(nodeIntegration)를 열어주는 대신, 녹음 채널 하나만 보낼 수 있는
// 아주 작은 대역(shim)만 넣어준다. (contextIsolation:false 라서 window 를 페이지와 같이 쓴다)
const { ipcRenderer } = require('electron')

const shim = {
  ipcRenderer: {
    send: (channel, data) => { if (channel === 'bcast:rec' || channel === 'bcast:show-panel' || channel === 'bcast:slot') ipcRenderer.send(channel, data) },
  },
}
try {
  Object.defineProperty(window, 'require', {
    value: (m) => (m === 'electron' ? shim : undefined),
    configurable: true,
    writable: false,
  })
} catch (_) {}
