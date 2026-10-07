// 에디냥 PC판 — 에디냥 웹(서버)을 그대로 띄우고, PC에서만 되는 "🎙️ 방송하기"를 더한 프로그램.
//  · 창 1 (에디냥 창): 에디냥 웹 그대로. 로그인/메뉴/데이터는 전부 서버에 있어서 모바일·다른 PC와 똑같이 이어진다.
//  · 창 2 (방송 창): 스푼 웹. 여기서 방송을 켜면 고음질 사운드 엔진(broadcast_inject.js)이 마이크 대신
//    리버브·EQ·컴프레서·배경음악·효과음이 섞인 소리를 넣는다. (짜잔 에디봇 방송하기와 같은 엔진)
//  · 에디냥 창의 🎙️ 방송하기 메뉴 → (preload-app.js) → 여기 IPC → 방송 창 엔진(window.__ediAudio) 순서로 조절된다.
const { app, BrowserWindow, ipcMain, shell, dialog, desktopCapturer, globalShortcut, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')

// 에디냥 서버 주소 — 실행할 때 EDINYANG_SERVER 환경변수로 바꿔서 테스트 서버에도 붙일 수 있다
const SERVER = (process.env.EDINYANG_SERVER || 'https://spoon-game-server.onrender.com').replace(/\/+$/, '')
const SPOON_URL = process.env.EDINYANG_SPOON_URL || 'https://www.spooncast.net/kr' // (테스트용으로만 바꿈)
const SPOON_PARTITION = 'persist:edinyang-spoon' // 방송 창 로그인은 따로 저장 (껐다 켜도 유지)

let appWin = null
let bcastWin = null
let bcastCloseOk = false
let engineCode = ''
let buttonCode = '' // 방송 창에 띄우는 🎙️ 방송하기 버튼 (spoon_button.js)
let bcastSettings = null // 마지막으로 받은 사운드 설정 — 방송 창이 새 페이지를 열 때마다 다시 넣는다
let pcWanted = false // PC 소리 켜둔 상태인지 — 방송 창이 페이지를 새로 열면 PC 소리도 다시 켠다
let localPort = 0

const alive = (w) => w && !w.isDestroyed()

if (!app.requestSingleInstanceLock()) { app.quit() }
app.on('second-instance', () => { if (alive(appWin)) { if (appWin.isMinimized()) appWin.restore(); appWin.show(); appWin.focus() } })

function sendToApp(channel, data) { if (alive(appWin)) appWin.webContents.send(channel, data) }

// ─────────────────────────────────────────────
// 🎵 음악·효과음 파일 → 방송 창이 재생할 수 있는 주소로 (사용자가 고른 파일만, 127.0.0.1 에서만)
// ─────────────────────────────────────────────
const bcastFiles = new Map() // id -> 절대경로
const BCAST_AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm', '.opus'])
const BCAST_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'audio/webm', '.opus': 'audio/ogg' }

function serveBcastFile(req, res) {
  const id = decodeURIComponent((req.url || '').slice('/bcast-file/'.length).split('?')[0])
  const fp = bcastFiles.get(id)
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
  if (!fp || !fs.existsSync(fp)) { res.writeHead(404, cors); res.end('Not Found'); return }
  const size = fs.statSync(fp).size
  const type = BCAST_MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream'
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0
    const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
    if (start >= size || start > end) { res.writeHead(416, { ...cors, 'Content-Range': `bytes */${size}` }); res.end(); return }
    res.writeHead(206, { ...cors, 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    fs.createReadStream(fp, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { ...cors, 'Content-Type': type, 'Content-Length': size })
    fs.createReadStream(fp).pipe(res)
  }
}

function startLocalServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        if ((req.url || '').startsWith('/bcast-file/')) return serveBcastFile(req, res)
        res.writeHead(404); res.end()
      } catch (_) { try { res.writeHead(500); res.end() } catch (__) {} }
    })
    server.listen(0, '127.0.0.1', () => { localPort = server.address().port; resolve() })
  })
}

// ─────────────────────────────────────────────
// 📻 방송 창 (스푼 웹) — 사운드 엔진 주입
// ─────────────────────────────────────────────
// 화면 공유 요청이 오면 화면 대신 "PC 전체 소리(loopback)"를 넘겨준다 (엔진의 🔊 PC 소리 섞기용, 윈도우)
function setupLoopback(ses) {
  try {
    if (!ses || ses.__ediLoopback) return
    ses.__ediLoopback = true
    ses.setDisplayMediaRequestHandler((_req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] })
        .then((src) => cb(src && src[0] ? { video: src[0], audio: 'loopback' } : {}))
        .catch(() => cb({}))
    })
  } catch (e) { console.warn('[방송하기] PC 소리 잡기 설정 실패:', e.message) }
}

// 방송 창이 페이지를 새로 열 때마다 엔진을 넣고, 마지막 설정도 다시 적용
function hookEngine(win) {
  const wc = win.webContents
  wc.on('dom-ready', () => {
    if (!engineCode) return
    wc.executeJavaScript(engineCode, true).then(() => {
      if (bcastSettings) return wc.executeJavaScript(`window.__ediAudio && window.__ediAudio.set(${JSON.stringify(bcastSettings)})`, true)
    }).then(() => {
      if (pcWanted) return wc.executeJavaScript('window.__ediAudio && window.__ediAudio.set({ pcOn: true })', true)
    }).catch(() => {})
    if (buttonCode) wc.executeJavaScript(buttonCode, true).catch(() => {})
  })
}

function openBroadcastWin() {
  if (alive(bcastWin)) {
    if (bcastWin.isMinimized()) bcastWin.restore()
    bcastWin.show(); bcastWin.focus()
    return
  }
  const { screen } = require('electron')
  const wa = screen.getPrimaryDisplay().workAreaSize
  bcastWin = new BrowserWindow({
    width: Math.min(520, wa.width), height: wa.height, x: 40, y: 0,
    title: '📻 에디냥 방송 창',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      partition: SPOON_PARTITION,
      preload: path.join(__dirname, 'preload-spoon.js'),
      contextIsolation: false, // 엔진이 스푼 웹과 같은 window 를 써야 마이크 요청을 가로챌 수 있다
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 창을 내려놔도 소리 처리가 느려지지 않게
    },
  })
  bcastWin.setMenuBarVisibility(false)
  hookEngine(bcastWin)
  setupLoopback(bcastWin.webContents.session)
  bcastWin.loadURL(SPOON_URL)
  bcastWin.on('page-title-updated', (e) => { e.preventDefault() })
  // 스푼 웹 안에서 새 창으로 여는 링크는 같은 창에서 (스푼 외 주소는 기본 브라우저로)
  // 스푼 로그인(카카오·구글·네이버·애플 등)은 작은 팝업 창을 열어서 진행하고, 끝나면 팝업이 스스로 닫힌다.
  // ⚠️ 예전엔 이 팝업 주소를 방송 창 자체에 열어서, 로그인이 끝나 팝업이 닫힐 때 방송 창까지 닫혀버렸다.
  // → 짜잔 에디봇처럼 팝업은 같은 로그인 저장소(partition)를 쓰는 별도 창으로 그대로 열어준다.
  bcastWin.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720, icon: path.join(__dirname, 'build', 'icon.png') },
  }))
  // 방송 중에 실수로 닫지 않게 확인
  bcastWin.on('close', (e) => {
    if (app.__quitting || bcastCloseOk) return
    e.preventDefault()
    const w = bcastWin
    const really = () => { bcastCloseOk = true; try { w.close() } catch (_) {} bcastCloseOk = false }
    w.webContents.executeJavaScript('window.__ediAudio ? window.__ediAudio.status() : null', true).then(async (st) => {
      if (!st || !st.active) return really()
      const { response } = await dialog.showMessageBox(w, { type: 'warning', buttons: ['계속 방송', '창 닫기'], defaultId: 0, cancelId: 0, message: '방송 중이에요. 방송 창을 닫으면 방송 소리가 끊겨요.', noLink: true })
      if (response === 1) really()
    }).catch(really)
  })
  bcastWin.on('closed', () => { bcastWin = null; sendToApp('bcast:win', false) })
  sendToApp('bcast:win', true)
}

// ─────────────────────────────────────────────
// 🎙️ 에디냥 창 ↔ 방송 창 엔진 연결 (짜잔 에디봇 bcast:* 와 같은 약속)
// ─────────────────────────────────────────────
const ALLOWED = new Set(['get', 'set', 'status', 'levels', 'devices', 'test', 'playBgm', 'stopBgm', 'playPad', 'bgmPause', 'bgmFade', 'playSfx', 'recStart', 'recStop'])

async function callIn(win, fn, arg) {
  const wc = win.webContents
  await wc.executeJavaScript(engineCode, true).catch(() => {}) // 아직 안 들어갔으면 넣기 (이미 있으면 그냥 지나감)
  return wc.executeJavaScript(`(async () => { const A = window.__ediAudio; if (!A) return { __err: '방송 창 준비 중이에요' }; return await A[${JSON.stringify(fn)}](${JSON.stringify(arg === undefined ? null : arg)}); })()`, true)
}

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('bcast:call', async (_e, fn, arg) => {
  if (!ALLOWED.has(fn)) return { ok: false, error: '알 수 없는 요청' }
  try {
    if (fn === 'set') {
      const a = (arg && typeof arg === 'object') ? { ...arg } : {}
      const pcOn = a.pcOn; delete a.pcOn
      bcastSettings = { ...(bcastSettings || {}), ...a }
      if (pcOn !== undefined) pcWanted = !!pcOn
      if (!alive(bcastWin)) return { ok: true, result: null } // 창을 열면 그때 적용된다
      let last = await callIn(bcastWin, 'set', a).catch(() => null)
      if (pcOn !== undefined) last = await callIn(bcastWin, 'set', { pcOn: !!pcOn }).catch(() => last)
      return { ok: true, result: last }
    }
    if (!alive(bcastWin)) return { ok: false, error: '방송 창을 먼저 열어주세요' }
    const r = await callIn(bcastWin, fn, arg)
    if (r && r.__err) return { ok: false, error: r.__err }
    return { ok: true, result: r, win: 'dj' }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('bcast:open-win', () => { openBroadcastWin(); return { ok: true } })

ipcMain.handle('bcast:file-url', (_e, filePath) => {
  try {
    const fp = path.resolve(String(filePath || ''))
    if (!BCAST_AUDIO_EXT.has(path.extname(fp).toLowerCase()) || !fs.existsSync(fp)) return { ok: false, error: '음악 파일(mp3·wav·ogg·m4a 등)만 쓸 수 있어요.' }
    const id = crypto.createHash('sha1').update(fp).digest('hex').slice(0, 16) + path.extname(fp).toLowerCase()
    bcastFiles.set(id, fp)
    return { ok: true, url: `http://127.0.0.1:${localPort}/bcast-file/${encodeURIComponent(id)}`, name: path.basename(fp) }
  } catch (e) { return { ok: false, error: e.message } }
})

// ⏺️ 방송 녹음 — 방송 창에서 5초마다 보내는 조각을 다운로드\에디냥 방송녹음 폴더에 이어 붙여 저장
const recDir = () => path.join(app.getPath('downloads'), '에디냥 방송녹음')
const recFiles = new Map() // id -> { fd, file }
const pad2 = (n) => String(n).padStart(2, '0')
// 🎙️ 방송 창의 "방송하기" 버튼 → 에디냥 창을 앞으로 가져오고 방송하기 팝업 열기
ipcMain.on('bcast:show-panel', (e) => {
  if (!alive(bcastWin) || e.sender !== bcastWin.webContents || !alive(appWin)) return
  if (appWin.isMinimized()) appWin.restore()
  appWin.show(); appWin.focus()
  appWin.webContents.executeJavaScript("typeof bcFloatOpen === 'function' && (bcFloatOpen(), true)", true).catch(() => {})
})

ipcMain.on('bcast:rec', (e, m) => {
  try {
    if (!alive(bcastWin) || e.sender !== bcastWin.webContents) return // 방송 창에서 온 것만
    if (!m || !m.id) return
    if (m.op === 'start') {
      fs.mkdirSync(recDir(), { recursive: true })
      const d = new Date(m.id)
      const file = path.join(recDir(), `방송녹음_${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}.webm`)
      recFiles.set(m.id, { fd: fs.openSync(file, 'a'), file })
      sendToApp('bcast:rec-state', { on: true, file })
    } else if (m.op === 'chunk') {
      const r = recFiles.get(m.id); if (!r || !m.buf) return
      fs.writeSync(r.fd, Buffer.from(m.buf))
    } else if (m.op === 'end') {
      const r = recFiles.get(m.id); if (!r) return
      try { fs.closeSync(r.fd) } catch (_) {}
      recFiles.delete(m.id)
      sendToApp('bcast:rec-state', { on: false, file: r.file, saved: true })
    }
  } catch (err) { console.warn('[방송녹음] 실패:', err.message) }
})
ipcMain.handle('bcast:rec-folder', () => { try { fs.mkdirSync(recDir(), { recursive: true }); shell.openPath(recDir()); return { ok: true } } catch (e) { return { ok: false, error: e.message } } })

// ⌨️ 방송 단축키 — 다른 창을 보고 있어도 동작 (F1~F8 효과음 · F9 마이크 끄기 · F10 음악 부드럽게 끄기/켜기)
let hkKeys = []
const hkClear = () => { hkKeys.forEach((k) => { try { globalShortcut.unregister(k) } catch (_) {} }); hkKeys = [] }
ipcMain.handle('bcast:hotkeys', (_e, mode) => {
  hkClear()
  if (mode !== 'f' && mode !== 'ctrl') return { ok: true, keys: [] }
  const map = []
  for (let i = 1; i <= 8; i++) map.push([mode === 'f' ? `F${i}` : `CommandOrControl+Shift+${i}`, `pad${i}`])
  map.push([mode === 'f' ? 'F9' : 'CommandOrControl+Shift+9', 'mute'])
  map.push([mode === 'f' ? 'F10' : 'CommandOrControl+Shift+0', 'fade'])
  const failed = []
  for (const [acc, act] of map) {
    try { if (globalShortcut.register(acc, () => sendToApp('bcast:hotkey', act))) hkKeys.push(acc); else failed.push(acc) } catch (_) { failed.push(acc) }
  }
  return { ok: true, keys: hkKeys, failed }
})

// ─────────────────────────────────────────────
// 🐱 에디냥 창 (웹 그대로)
// ─────────────────────────────────────────────
const isServerUrl = (url) => { try { return new URL(url).origin === new URL(SERVER).origin } catch (_) { return false } }

function createAppWin() {
  appWin = new BrowserWindow({
    width: 1320, height: 880, minWidth: 900, minHeight: 600,
    title: '에디냥 PC',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-app.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 창을 내려놔도 효과음/알림이 밀리지 않게
    },
  })
  appWin.setMenuBarVisibility(false)
  appWin.loadURL(SERVER)
  // 에디냥 안의 팝업(선물 캡처 등)은 앱 안에서, 다른 사이트 링크는 기본 브라우저로
  appWin.webContents.setWindowOpenHandler(({ url }) => {
    if (isServerUrl(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png') } }
    shell.openExternal(url); return { action: 'deny' }
  })
  appWin.webContents.on('will-navigate', (e, url) => { if (!isServerUrl(url)) { e.preventDefault(); shell.openExternal(url) } })
  appWin.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return // -3 = 사용자가 취소
    appWin.webContents.executeJavaScript(`document.body.innerHTML='<div style="font-family:sans-serif;padding:40px;text-align:center"><h2>에디냥 서버에 연결하지 못했어요</h2><p style="color:#666">인터넷 연결을 확인하고 다시 시도해주세요. (${String(desc).replace(/[<>'"]/g, '')})</p><button onclick="location.href=${JSON.stringify(SERVER)}" style="padding:10px 20px;font-size:15px;cursor:pointer">다시 시도</button></div>'`).catch(() => {})
  })
  appWin.on('close', (e) => {
    if (app.__quitting) return
    if (alive(bcastWin)) {
      // 방송 창이 열려 있으면 같이 닫을지 물어본다 (방송 중이면 경고)
      e.preventDefault()
      bcastWin.webContents.executeJavaScript('window.__ediAudio ? window.__ediAudio.status() : null', true).catch(() => null).then(async (st) => {
        const onAir = st && st.active
        const { response } = await dialog.showMessageBox(appWin, { type: onAir ? 'warning' : 'question', buttons: ['취소', '모두 닫기'], defaultId: 0, cancelId: 0, message: onAir ? '방송 중이에요. 에디냥 PC를 닫으면 방송 창도 닫혀서 방송 소리가 끊겨요.' : '방송 창도 같이 닫을까요?', noLink: true })
        if (response === 1) { app.__quitting = true; app.quit() }
      })
    }
  })
  appWin.on('closed', () => { appWin = null })
}

// ─────────────────────────────────────────────
// 🔄 자동 업데이트 — GitHub 릴리즈(1328218g-cyber/spoon-game)에 새 버전이 올라오면 뒤에서 받아두고,
// 다 받으면 "지금 재시작할까요?"를 물어본다. 방송 중이면 묻지 않고, 프로그램을 끌 때 자동으로 설치된다.
// (설치 파일로 깔린 경우에만 동작 — npm start 개발 실행에서는 건너뜀)
// ─────────────────────────────────────────────
async function isOnAir() {
  if (!alive(bcastWin)) return false
  try { const st = await bcastWin.webContents.executeJavaScript('window.__ediAudio ? window.__ediAudio.status() : null', true); return !!(st && st.active) } catch (_) { return false }
}
function setupAutoUpdate() {
  if (!app.isPackaged) return
  let autoUpdater
  try { autoUpdater = require('electron-updater').autoUpdater } catch (e) { console.warn('[업데이트] electron-updater 없음:', e.message); return }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true // 지금 재시작 안 해도, 다음에 끌 때 설치된다
  let asked = false
  const askRestart = async (info) => {
    if (asked || !alive(appWin)) return
    if (await isOnAir()) { setTimeout(() => askRestart(info), 10 * 60 * 1000); return } // 방송 중엔 10분 뒤 다시
    asked = true
    const { response } = await dialog.showMessageBox(appWin, {
      type: 'info', buttons: ['나중에 (끌 때 설치)', '지금 재시작'], defaultId: 1, cancelId: 0, noLink: true,
      message: `에디냥 PC 새 버전(${info && info.version ? 'v' + info.version : ''})이 준비됐어요.`,
      detail: '지금 재시작하면 바로 적용돼요. 나중에를 누르면 프로그램을 끌 때 자동으로 설치돼요.',
    })
    if (response === 1) { app.__quitting = true; setImmediate(() => autoUpdater.quitAndInstall()) }
  }
  autoUpdater.on('update-downloaded', askRestart)
  autoUpdater.on('error', (e) => console.warn('[업데이트] 확인 실패:', e && e.message))
  const check = () => autoUpdater.checkForUpdates().catch((e) => console.warn('[업데이트] 확인 실패:', e && e.message))
  setTimeout(check, 5000)
  setInterval(check, 3 * 60 * 60 * 1000) // 켜둔 채로 오래 써도 3시간마다 확인
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  try { engineCode = fs.readFileSync(path.join(__dirname, 'broadcast_inject.js'), 'utf-8') } catch (e) { console.warn('[방송하기] 엔진 파일 없음:', e.message) }
  try { buttonCode = fs.readFileSync(path.join(__dirname, 'spoon_button.js'), 'utf-8') } catch (e) { console.warn('[방송하기] 버튼 파일 없음:', e.message) }
  await startLocalServer()
  createAppWin()
  setupAutoUpdate()
})

app.on('before-quit', () => { app.__quitting = true })
app.on('will-quit', hkClear)
app.on('window-all-closed', () => { app.quit() })
