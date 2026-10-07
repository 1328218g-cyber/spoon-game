// 에디냥 PC판 — 에디냥 웹(서버)을 그대로 띄우고, PC에서만 되는 "🎙️ 방송하기"를 더한 프로그램.
//  · 창 1 (에디냥 창): 에디냥 웹 그대로. 로그인/메뉴/데이터는 전부 서버에 있어서 모바일·다른 PC와 똑같이 이어진다.
//  · 창 2 (방송 창): 스푼 웹. 여기서 방송을 켜면 고음질 사운드 엔진(broadcast_inject.js)이 마이크 대신
//    리버브·EQ·컴프레서·배경음악·효과음이 섞인 소리를 넣는다. (짜잔 에디봇 방송하기와 같은 엔진)
//  · 에디냥 창의 🎙️ 방송하기 메뉴 → (preload-app.js) → 여기 IPC → 방송 창 엔진(window.__ediAudio) 순서로 조절된다.
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, desktopCapturer, globalShortcut, Menu, protocol, session, net, clipboard } = require('electron')
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
let panelWin = null // 방송 창의 🎙️ 버튼으로 여는 방송하기 팝업 창 (서버 /bcpanel)
let dockView = null // 방송 창 왼쪽(스푼 "오디오 설정" 자리)에 고정으로 붙는 방송하기 화면 (서버 /bcpanel)
let bcastCloseOk = false
let engineCode = ''
let buttonCode = '' // 방송 창에 띄우는 🎙️ 방송하기 버튼 (spoon_button.js)
let bcastSettings = null // 마지막으로 받은 사운드 설정 — 방송 창이 새 페이지를 열 때마다 다시 넣는다
let pcWanted = false // PC 소리 켜둔 상태인지 — 방송 창이 페이지를 새로 열면 PC 소리도 다시 켠다
let localPort = 0

const alive = (w) => w && !w.isDestroyed()

if (!app.requestSingleInstanceLock()) { app.quit() }
app.on('second-instance', () => { if (alive(appWin)) { if (appWin.isMinimized()) appWin.restore(); appWin.show(); appWin.focus() } })

function sendToApp(channel, data) {
  if (alive(appWin)) appWin.webContents.send(channel, data)
  // 방송하기 팝업 창에도 상태(녹음·방송 창 열림)는 알려준다 — 단축키는 에디냥 창 한 곳에서만 처리 (두 번 울리지 않게)
  if (alive(panelWin) && channel !== 'bcast:hotkey') panelWin.webContents.send(channel, data)
  if (dockView && !dockView.webContents.isDestroyed() && channel !== 'bcast:hotkey') dockView.webContents.send(channel, data)
}

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

// 스푼 웹(https)은 보안 규칙(CSP·사설망 차단) 때문에 http://127.0.0.1 음악 주소를 못 불러온다 → "재생 실패".
// 그래서 방송 창 전용 주소(edinyang-file://f/…)를 따로 만들고, 앱 안에서 로컬 음악 서버로 이어준다 (보안 설정은 그대로).
const FILE_SCHEME = 'edinyang-file'
protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }])
function setupFileScheme() {
  session.fromPartition(SPOON_PARTITION).protocol.handle(FILE_SCHEME, (req) => {
    const id = new URL(req.url).pathname.replace(/^\/+/, '')
    return net.fetch(`http://127.0.0.1:${localPort}/bcast-file/${id}`, { method: req.method, headers: req.headers })
  })
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

const bcastBoundsFile = () => path.join(app.getPath('userData'), 'bcast-window.json')
function openBroadcastWin() {
  if (alive(bcastWin)) {
    if (bcastWin.isMinimized()) bcastWin.restore()
    bcastWin.show(); bcastWin.focus()
    return
  }
  // 크기·위치: 마지막으로 쓰던 그대로, 처음이면 스푼 방송 화면(왼쪽 방송하기 · 가운데 방송 · 오른쪽 청취자)이 다 보이게 넓게
  const { screen } = require('electron')
  const wa = screen.getPrimaryDisplay().workArea
  let bnd = null
  try { bnd = JSON.parse(fs.readFileSync(bcastBoundsFile(), 'utf8')) } catch (_) {}
  const onScreen = bnd && screen.getAllDisplays().some((d) => { const a = d.workArea; return bnd.x < a.x + a.width - 80 && bnd.x + bnd.width > a.x + 80 && bnd.y >= a.y - 20 && bnd.y < a.y + a.height - 80 })
  if (!onScreen || !(bnd.width >= 400) || !(bnd.height >= 300)) {
    const width = Math.min(1360, wa.width), height = wa.height
    bnd = { width, height, x: wa.x + Math.max(0, Math.round((wa.width - width) / 2)), y: wa.y }
  }
  bcastWin = new BrowserWindow({
    width: bnd.width, height: bnd.height, x: bnd.x, y: bnd.y,
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
    try { if (!bcastWin.isMinimized() && !bcastWin.isMaximized() && !bcastWin.isFullScreen()) fs.writeFileSync(bcastBoundsFile(), JSON.stringify(bcastWin.getBounds())) } catch (_) {}
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
  bcastWin.on('closed', () => { destroyDock(); bcastWin = null; sendToApp('bcast:win', false) })
  sendToApp('bcast:win', true)
}

// ─────────────────────────────────────────────
// 🎙️ 에디냥 창 ↔ 방송 창 엔진 연결 (짜잔 에디봇 bcast:* 와 같은 약속)
// ─────────────────────────────────────────────
const ALLOWED = new Set(['get', 'set', 'status', 'levels', 'devices', 'test', 'playBgm', 'stopBgm', 'playPad', 'bgmPause', 'bgmFade', 'playSfx', 'recStart', 'recStop', 'outro'])

async function callIn(win, fn, arg) {
  const wc = win.webContents
  await wc.executeJavaScript(engineCode, true).catch(() => {}) // 아직 안 들어갔으면 넣기 (이미 있으면 그냥 지나감)
  return wc.executeJavaScript(`(async () => { const A = window.__ediAudio; if (!A) return { __err: '방송 창 준비 중이에요' }; try { return await A[${JSON.stringify(fn)}](${JSON.stringify(arg === undefined ? null : arg)}); } catch (e) { return { __err: String((e && (e.message || e.name)) || e || '재생 실패') }; } })()`, true)
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
    return { ok: true, url: `${FILE_SCHEME}://f/${encodeURIComponent(id)}`, name: path.basename(fp) }
  } catch (e) { return { ok: false, error: e.message } }
})

// ⏺️ 방송 녹음 — 방송 창에서 5초마다 보내는 조각을 다운로드\에디냥 방송녹음 폴더에 이어 붙여 저장
const recDir = () => path.join(app.getPath('downloads'), '에디냥 방송녹음')
const recFiles = new Map() // id -> { fd, file }
const pad2 = (n) => String(n).padStart(2, '0')
// 🎙️ 방송 창의 "방송하기" 버튼 → 방송 창 위에 방송하기 팝업 창을 띄운다 (에디냥 창은 그대로 두고)
function openPanelWin() {
  if (alive(panelWin)) { if (panelWin.isMinimized()) panelWin.restore(); panelWin.show(); panelWin.focus(); return }
  const { screen } = require('electron')
  const wa = screen.getPrimaryDisplay().workAreaSize
  const b = alive(bcastWin) ? bcastWin.getBounds() : { x: 40, y: 0, width: 520 }
  const width = Math.min(680, wa.width), height = Math.min(860, wa.height)
  // 방송 창 오른쪽 옆에 붙여서 띄우고, 자리가 없으면 화면 오른쪽 끝
  const x = Math.min(b.x + b.width + 8, Math.max(0, wa.width - width)), y = Math.max(0, b.y)
  panelWin = new BrowserWindow({
    width, height, x, y, title: '🎙️ 에디냥 방송하기',
    parent: alive(bcastWin) ? bcastWin : undefined, // 방송 창보다 항상 위에
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload-app.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  panelWin.setMenuBarVisibility(false)
  panelWin.loadURL(SERVER + '/bcpanel')
  panelWin.on('page-title-updated', (e) => { e.preventDefault() })
  panelWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  panelWin.on('closed', () => { panelWin = null })
}
// 📌 방송 창 왼쪽 고정 화면 — 스푼 "오디오 설정" 칸 자리(spoon_button.js 가 알려줌)에 방송하기 화면을 겹쳐 띄운다
function destroyDock() {
  if (!dockView) return
  try { if (alive(bcastWin)) bcastWin.contentView.removeChildView(dockView) } catch (_) {}
  try { if (!dockView.webContents.isDestroyed()) dockView.webContents.close() } catch (_) {}
  dockView = null
}
ipcMain.on('bcast:slot', (e, rect) => {
  if (!alive(bcastWin) || e.sender !== bcastWin.webContents) return
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) { if (dockView) dockView.setVisible(false); return }
  if (!dockView) {
    dockView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-app.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    dockView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
    dockView.webContents.loadURL(SERVER + '/bcpanel?dock=1')
    bcastWin.contentView.addChildView(dockView)
  }
  const z = bcastWin.webContents.getZoomFactor() || 1
  dockView.setBounds({ x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.round(rect.w * z), height: Math.round(rect.h * z) })
  dockView.setVisible(true)
})

ipcMain.on('bcast:show-panel', (e) => {
  if (!alive(bcastWin) || e.sender !== bcastWin.webContents) return
  openPanelWin()
})
// 🐱 방송 창 위쪽 에디냥 메뉴 바로가기 (spoon_button.js)
//  · ＋ 를 누르면 에디냥 창의 메뉴 목록(사이드바에 보이는 것)을 넘겨준다
//  · 바로가기를 누르면 그 메뉴만 보이는 팝업 창을 연다 (메뉴마다 창 하나, 이미 열려 있으면 앞으로)
ipcMain.on('bcast:menus', async (e) => {
  if (!alive(bcastWin) || e.sender !== bcastWin.webContents) return
  let list = []
  try {
    if (alive(appWin)) {
      list = await appWin.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('appRoot'); if (!root || !root.classList.contains('ready')) return []
        return [...document.querySelectorAll('#sidebar .nav-item[data-panel]')]
          .filter((n) => n.dataset.panel !== 'broadcast' && getComputedStyle(n).display !== 'none')
          .map((n) => { const img = n.querySelector('.ic img'); const ic = n.querySelector('.ic'); const lb = n.querySelector('.lbl')
            return { p: n.dataset.panel, l: ((lb || n).textContent || '').trim(), ic: img ? img.src : '', e: !img && ic ? (ic.textContent || '').trim() : '' } })
      })()`, true)
    }
  } catch (_) { list = [] }
  if (alive(bcastWin)) bcastWin.webContents.executeJavaScript(`window.__ediMenus && window.__ediMenus(${JSON.stringify(Array.isArray(list) ? list : [])})`).catch(() => {})
})
// 🎁 선물 이펙트 — 에디냥 창이 선물 소식을 받으면 방송 창(스푼) 가운데에 스푼 원본 애니메이션(lottie)을 띄운다
//  애니메이션 파일은 여기서 받아서 넘겨준다 (스푼 웹 보안 규칙에 막히지 않게) · 플레이어는 vendor/lottie_svg.min.js
let lottieCode = null
const lottieCache = new Map() // url -> json 문자열 (최근 40개)
async function getLottieJson(url) {
  try {
    const u = new URL(String(url || ''))
    if (u.protocol !== 'https:' || !/(^|\.)spooncast\.net$/.test(u.hostname)) return null
    if (lottieCache.has(url)) { const v = lottieCache.get(url); lottieCache.delete(url); lottieCache.set(url, v); return v }
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 4000) // 오래 걸리면 기다리지 않고 그림으로
    let r
    try { r = await net.fetch(url, { signal: ac.signal }) } finally { clearTimeout(to) }
    if (!r.ok) return null
    const txt = await r.text()
    if (txt.length > 6 * 1024 * 1024) return null
    JSON.parse(txt) // 올바른 JSON 인지 확인
    lottieCache.set(url, txt)
    if (lottieCache.size > 40) lottieCache.delete(lottieCache.keys().next().value)
    return txt
  } catch (_) { return null }
}
ipcMain.on('bcast:gift', async (e, d) => {
  if (!alive(appWin) || e.sender !== appWin.webContents || !alive(bcastWin) || !d || typeof d !== 'object') return
  const s = (v, n) => String(v == null ? '' : v).slice(0, n)
  const g = { nick: s(d.nick, 60), sticker: s(d.sticker, 80), image: s(d.stickerImage, 500), lottieUrl: s(d.lottieUrl, 500), combo: Math.max(1, Math.min(9999, Number(d.comboCount) || 1)), amount: Math.max(0, Math.min(1e7, Number(d.amount) || 0)) }
  const wc = bcastWin.webContents
  // 애니메이션 준비가 실패해도 선물 그림으로는 꼭 띄운다
  let anim = null
  try {
    if (g.lottieUrl) {
      anim = await getLottieJson(g.lottieUrl)
      if (anim) {
        if (lottieCode == null) { try { lottieCode = fs.readFileSync(path.join(__dirname, 'vendor', 'lottie_svg.min.js'), 'utf-8') } catch (_) { lottieCode = '' } }
        // 스푼 웹이 쓰는 lottie 와 섞이지 않게 따로 담아둔다 (window.__ediLottie)
        if (lottieCode) await wc.executeJavaScript(`if (!window.__ediLottie) { (function () { var module = { exports: {} }, exports = module.exports, define; ${lottieCode}\n; window.__ediLottie = module.exports; })(); } true`, true)
        else anim = null
      }
    }
  } catch (err) { console.warn('[선물 이펙트] 애니메이션 준비 실패:', err && err.message); anim = null }
  try {
    if (!alive(bcastWin)) return
    await wc.executeJavaScript(`window.__ediGiftFx && window.__ediGiftFx(${JSON.stringify(g)}, ${anim || 'null'})`, true)
  } catch (err) { console.warn('[선물 이펙트] 표시 실패:', err && err.message) }
})
// 📸 방송 화면 캡처 — 방송 창 가운데 칸(선물 애니메이션 포함)을 사진으로: 사진\에디냥 캡처 폴더에 저장 + 클립보드에 복사
const captureDir = () => path.join(app.getPath('pictures'), '에디냥 캡처')
ipcMain.on('bcast:capture', async (e, r) => {
  if (!alive(bcastWin) || e.sender !== bcastWin.webContents) return
  const wc = bcastWin.webContents
  const done = (res) => wc.executeJavaScript(`window.__ediCaptured && window.__ediCaptured(${JSON.stringify(res)})`).catch(() => {})
  try {
    const z = wc.getZoomFactor() || 1
    const num = (v) => Math.max(0, Math.round((Number(v) || 0) * z))
    const rect = r && r.w > 20 && r.h > 20 ? { x: num(r.x), y: num(r.y), width: num(r.w), height: num(r.h) } : undefined
    const img = await wc.capturePage(rect)
    if (img.isEmpty()) throw new Error('화면을 못 찍었어요')
    fs.mkdirSync(captureDir(), { recursive: true })
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0')
    const file = path.join(captureDir(), `에디냥_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}_${String(d.getMilliseconds()).padStart(3, '0')}.png`)
    fs.writeFileSync(file, img.toPNG())
    try { clipboard.writeImage(img) } catch (_) {}
    done({ ok: true, file: path.basename(file) })
  } catch (err) { done({ ok: false, error: (err && err.message) || String(err) }) }
})
ipcMain.on('bcast:capture-folder', (e) => {
  if (!alive(bcastWin) || e.sender !== bcastWin.webContents) return
  try { fs.mkdirSync(captureDir(), { recursive: true }); shell.openPath(captureDir()) } catch (_) {}
})
const menuWins = new Map() // 메뉴 이름 -> 팝업 창
ipcMain.on('bcast:open-menu', async (e, m) => {
  if (!alive(bcastWin) || e.sender !== bcastWin.webContents) return
  const panel = String((m && m.p) || ''), label = String((m && m.l) || panel).slice(0, 40)
  if (!/^[a-z0-9_-]{1,40}$/i.test(panel)) return
  const old = menuWins.get(panel)
  if (alive(old)) { if (old.isMinimized()) old.restore(); old.show(); old.focus(); return }
  // "자동 로그인 유지"를 안 켜서 에디냥 창에만 로그인 정보가 있는 경우를 위해 같이 넘겨준다
  let auth = {}
  try { if (alive(appWin)) auth = await appWin.webContents.executeJavaScript("({ t: typeof djToken !== 'undefined' ? djToken : '', id: typeof djId !== 'undefined' ? djId : '' })", true) || {} } catch (_) {}
  const { screen } = require('electron')
  const wa = screen.getPrimaryDisplay().workArea
  const b = alive(bcastWin) ? bcastWin.getBounds() : { x: wa.x + 40, y: wa.y, width: 520 }
  const width = Math.min(760, wa.width), height = Math.min(860, wa.height)
  const n = menuWins.size
  const w = new BrowserWindow({
    width, height,
    x: Math.round(Math.max(wa.x, Math.min(wa.x + wa.width - width, b.x + 140 + n * 28))),
    y: Math.round(Math.max(wa.y, Math.min(wa.y + wa.height - height, b.y + 70 + n * 28))),
    title: `🐱 ${label}`,
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-menu.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      additionalArguments: ['--edi-auth=' + Buffer.from(JSON.stringify({ t: String(auth.t || ''), id: String(auth.id || '') })).toString('base64')],
    },
  })
  menuWins.set(panel, w)
  w.on('page-title-updated', (ev) => { ev.preventDefault() })
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  w.on('closed', () => { if (menuWins.get(panel) === w) menuWins.delete(panel) })
  w.loadURL(SERVER + '/?menu=' + encodeURIComponent(panel))
})
// 팝업 창이 로그인 정보를 물어볼 때 ("자동 로그인 유지"를 안 켜서 에디냥 창에만 있는 경우)
ipcMain.handle('app:token', async (e) => {
  const fromPanel = alive(panelWin) && e.sender === panelWin.webContents
  const fromDock = dockView && !dockView.webContents.isDestroyed() && e.sender === dockView.webContents
  if ((!fromPanel && !fromDock) || !alive(appWin)) return ''
  try { return await appWin.webContents.executeJavaScript("typeof djToken !== 'undefined' ? djToken : ''", true) } catch (_) { return '' }
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
  if (mode !== 'f' && mode !== 'ctrl' && mode !== 'num') return { ok: true, keys: [] }
  // F1~F10 · Ctrl+Shift+숫자 · 오른쪽 숫자 키패드(Num Lock 켜고 1~8 효과음 · 9 마이크 · 0 음악 페이드)
  const key = (n) => (mode === 'f' ? `F${n === 0 ? 10 : n}` : mode === 'num' ? `num${n}` : `CommandOrControl+Shift+${n}`)
  const map = []
  for (let i = 1; i <= 8; i++) map.push([key(i), `pad${i}`])
  map.push([key(9), 'mute'])
  map.push([key(0), 'fade'])
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
  try { setupFileScheme() } catch (e) { console.warn('[방송하기] 음악 주소 준비 실패:', e.message) }
  createAppWin()
  setupAutoUpdate()
})

app.on('before-quit', () => { app.__quitting = true })
app.on('will-quit', hkClear)
app.on('window-all-closed', () => { app.quit() })
