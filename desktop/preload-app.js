// preload-app.js — 에디냥 웹 창에 "PC판 전용" 기능(방송하기)을 열어주는 다리.
// 에디냥 웹(index.html)은 window.bcast 가 있으면 PC판으로 보고 사이드바에 🎙️ 방송하기 메뉴를 보여준다.
// 웹 페이지에는 아래에 적힌 함수만 노출되고, Node/Electron 자체는 노출되지 않는다.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('bcast', {
  isEdiNyangDesktop: true,
  version: () => ipcRenderer.invoke('app:version'),
  appToken: () => ipcRenderer.invoke('app:token'), // 방송하기 팝업 창 전용 (에디냥 창의 로그인 정보)
  call: (fn, arg) => ipcRenderer.invoke('bcast:call', fn, arg),
  fileUrl: (p) => ipcRenderer.invoke('bcast:file-url', p),
  // 파일 선택창에서 고른 파일의 실제 경로 (음악·효과음 파일을 방송 창에서 재생하려면 경로가 필요)
  pathOf: (file) => {
    try { if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file) || '' } catch (_) {}
    try { return (file && file.path) || '' } catch (_) { return '' }
  },
  mode: () => Promise.resolve({ ok: true, mode: 'dj' }),
  openWin: () => ipcRenderer.invoke('bcast:open-win'),
  onWin: (cb) => ipcRenderer.on('bcast:win', (_e, open) => cb(!!open)),
  recFolder: () => ipcRenderer.invoke('bcast:rec-folder'),
  onRec: (cb) => ipcRenderer.on('bcast:rec-state', (_e, st) => cb(st || {})),
  hotkeys: (mode) => ipcRenderer.invoke('bcast:hotkeys', mode),
  onHotkey: (cb) => ipcRenderer.on('bcast:hotkey', (_e, act) => cb(act)),
  giftFx: (d) => ipcRenderer.send('bcast:gift', d), // 🎁 선물 받으면 방송 창에 이펙트
})
