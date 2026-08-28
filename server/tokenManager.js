// server/tokenManager.js
// PC(또는 크롬 확장)에서 추출한 세션 쿠키 + localStorage/sessionStorage를 이용해,
// 서버가 스스로 accessToken/roomToken을 재발급받아 유지하는 모듈.
// (구글/카카오/페북 로그인을 서버가 직접 자동화하지 않고,
//  이미 로그인된 세션을 그대로 재사용하는 방식)
//
// ⚠️ v2: djId별로 "여러 계정"을 동시에 관리하도록 확장됨.
//    이전 버전은 계정 하나(관리자)만 관리하는 싱글톤 구조였음.
//    모든 함수가 이제 djId를 첫 번째 인자로 받는다.

const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const ORIGIN = 'https://www.spooncast.net'

// ⏱️ Railway처럼 자원이 빠듯한 환경에서는 30초로도 페이지 로드가 빠듯할 때가 있어서
// (2026-08-11: Navigation timeout / Network.enable timed out 반복 발생 확인) 넉넉하게 늘렸다.
const NAV_TIMEOUT_MS = 55000
const PROTOCOL_TIMEOUT_MS = 90000 // CDP(크롬 원격제어 프로토콜) 자체 응답 타임아웃 — "Network.enable timed out" 에러의 직접적인 원인

// Railway Volume(영구 디스크)에 저장해두면, 서버가 재배포/재시작돼도
// 세션 쿠키를 다시 업로드하지 않아도 된다. (DATA_DIR 환경변수는 store.js와 동일하게 사용)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json') // { [djId]: { cookies, localStorage, sessionStorage } }

// djId -> { cookies, localStorage, sessionStorage, accessToken, refreshTimer, refreshing }
const accounts = {}

function getAccount(djId) {
  if (!accounts[djId]) {
    accounts[djId] = {
      cookies: null,
      localStorage: null,
      sessionStorage: null,
      accessToken: '',
      refreshTimer: null,
      refreshing: false,
    }
  }
  return accounts[djId]
}

let onTokenUpdate = null    // (djId, token) => void — 토큰 갱신 성공 시
let onSessionExpired = null // (djId) => void — 세션 만료(재로그인 필요) 감지 시

// Chrome이 크래시 리포터(crashpad handler) 프로세스를 추가로 띄우려다
// 컨테이너의 프로세스/메모리 한도(ulimit)에 걸려 통째로 죽는 경우가 있어,
// 그 핸들러 자체를 비활성화해서 리소스 사용을 최소화한다.
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--no-first-run',
  '--no-zygote',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--disable-background-networking',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--mute-audio',
]

// 컨테이너 자원이 일시적으로 부족해서(EAGAIN 등) launch가 실패하는 경우를 대비해
// 한 번 더 재시도한다. 그래도 실패하면 진짜 자원 부족(Railway 플랜 한도)일 가능성이 큼.
async function launchBrowser() {
  try {
    return await puppeteer.launch({ headless: 'new', args: LAUNCH_ARGS, protocolTimeout: PROTOCOL_TIMEOUT_MS })
  } catch (e) {
    console.log('[tokenManager] 브라우저 실행 실패, 1.5초 후 재시도:', e.message)
    await new Promise((r) => setTimeout(r, 1500))
    return await puppeteer.launch({ headless: 'new', args: LAUNCH_ARGS, protocolTimeout: PROTOCOL_TIMEOUT_MS })
  }
}
// browser.close()가 응답 없이 멈추거나 조용히 실패하면 Chrome 프로세스가 좀비로 남아
// 메모리를 계속 잡아먹다가 결국 컨테이너 전체가 OOM으로 죽을 수 있다.
// 그래서 일정 시간 안에 안 닫히면 프로세스를 강제로 죽인다(SIGKILL).
async function closeBrowserSafely(browser) {
  if (!browser) return
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 5000)),
    ])
  } catch (e) {
    console.log('[tokenManager] 브라우저 정상 종료 실패 → 강제 종료 시도:', e.message)
    try {
      const proc = browser.process && browser.process()
      if (proc && !proc.killed && proc.pid) {
        // 🚨 proc.kill()은 크롬 메인 프로세스 하나만 죽인다. 크롬은 렌더러/GPU/네트워크
        // 서비스 같은 하위 프로세스를 같이 띄우는데, 메인만 죽이면 그것들이 고아가 돼서
        // (컨테이너엔 좀비를 정리해줄 별도 init이 없어서) 좀비로 계속 쌓인다.
        // Puppeteer는 브라우저를 자신만의 프로세스 그룹으로 띄워두므로, PID를 음수로 넘기면
        // (process.kill(-pid, ...)) 그 그룹 전체를 한번에 죽여서 하위 프로세스까지 정리된다.
        try {
          process.kill(-proc.pid, 'SIGKILL')
        } catch (groupErr) {
          // 그룹킬이 안 먹히는 환경(플랫폼 차이 등)이면 최소한 메인 프로세스라도 죽인다.
          proc.kill('SIGKILL')
        }
      }
    } catch (_) { /* ignore */ }
  }
}
// Puppeteer(크롬)를 계정 여러 개가 동시에 띄우면 Railway의 적은 메모리로는
// 죽어버릴 수 있다. 그래서 계정과 무관하게 항상 하나씩만 실행되도록 전역으로 줄 세운다.
let puppeteerQueue = Promise.resolve()
function withPuppeteerLock(fn) {
  const run = puppeteerQueue.then(() => fn())
  puppeteerQueue = run.catch(() => {}) // 실패해도 다음 작업은 계속 진행되게
  return run
}

function persistToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    const out = {}
    for (const djId of Object.keys(accounts)) {
      const a = accounts[djId]
      if (!a.cookies || !a.cookies.length) continue // 세션 없는 계정은 저장 안 함
      out[djId] = { cookies: a.cookies, localStorage: a.localStorage, sessionStorage: a.sessionStorage }
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out, null, 2), 'utf-8')
  } catch (e) {
    console.log('[tokenManager] 세션 저장 실패:', e.message)
  }
}

// 서버 시작 시 호출 — 디스크에 저장된 모든 계정 세션을 불러온다. 몇 개 로드됐는지 djId 배열로 반환.
function initFromDisk() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      // 구버전(단일 계정) 파일이 남아있으면 관리자(sum) 계정으로 마이그레이션
      const legacyFile = path.join(DATA_DIR, 'session.json')
      if (fs.existsSync(legacyFile)) {
        const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'))
        const a = getAccount('sum')
        a.cookies = sanitizeCookies(legacy.cookies || [])
        a.localStorage = legacy.localStorage || null
        a.sessionStorage = legacy.sessionStorage || null
        console.log(`[tokenManager] 구버전 세션을 sum 계정으로 마이그레이션함 (쿠키 ${a.cookies.length}개)`)
        persistToDisk()
        return ['sum']
      }
      return []
    }
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'))
    const loaded = []
    for (const djId of Object.keys(data)) {
      const a = getAccount(djId)
      a.cookies = sanitizeCookies(data[djId].cookies || [])
      a.localStorage = data[djId].localStorage || null
      a.sessionStorage = data[djId].sessionStorage || null
      if (hasCookies(djId)) loaded.push(djId)
    }
    console.log(`[tokenManager] 디스크에서 세션 불러옴 (계정 ${loaded.length}개: ${loaded.join(', ')})`)
    return loaded
  } catch (e) {
    console.log('[tokenManager] 세션 불러오기 실패:', e.message)
    return []
  }
}

// Chrome 개발자도구/확장으로 내보낸 쿠키 JSON에는 puppeteer의 setCookie()가
// 모르는 필드(size 등)가 섞여 있을 수 있어, 필요한 필드만 남기고 정리한다.
function sanitizeCookies(cookies) {
  return (cookies || [])
    .filter(c => c && c.name && c.value)
    .map(c => {
      const out = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
      }
      if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires
      if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') out.sameSite = c.sameSite
      return out
    })
}

// data: { cookies, localStorage, sessionStorage } 객체. 구버전 형식(쿠키 배열만)도 하위호환으로 허용.
function setCookies(djId, data) {
  const a = getAccount(djId)
  if (Array.isArray(data)) {
    a.cookies = sanitizeCookies(data)
    a.localStorage = null
    a.sessionStorage = null
  } else {
    a.cookies = sanitizeCookies(data && data.cookies)
    a.localStorage = (data && data.localStorage) || null
    a.sessionStorage = (data && data.sessionStorage) || null
  }
  // 업로드된 쿠키 안에 이미 최신 accessToken(spoon_at_kr)이 들어있으면,
  // Puppeteer를 다시 띄워 재확인할 필요 없이 그 값을 바로 사용한다.
  // (PC의 2_auto_sync.js처럼 이미 갱신된 세션을 올려주는 경우 특히 유용 — 서버 쪽 Chrome 실행 횟수를 줄여줌)
  const atCookie = (a.cookies || []).find(c => c.name === 'spoon_at_kr')
  if (atCookie && atCookie.value) {
    a.accessToken = atCookie.value
    console.log(`[tokenManager:${djId}] ✅ 업로드된 쿠키에서 accessToken 즉시 반영 (Puppeteer 재확인 생략)`)
    if (onTokenUpdate) onTokenUpdate(djId, a.accessToken)
  }
  persistToDisk()
}

function hasCookies(djId) {
  const a = accounts[djId]
  return !!(a && a.cookies && a.cookies.length > 0)
}

// WebSocket 핸드셰이크 등에서 실제 브라우저처럼 Cookie 헤더를 그대로 실어 보내기 위한 문자열
function getCookieHeader(djId) {
  const a = accounts[djId]
  if (!a || !a.cookies || !a.cookies.length) return ''
  return a.cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

function getAccessToken(djId) {
  const a = accounts[djId]
  return a ? a.accessToken : ''
}

function setOnTokenUpdate(cb) { onTokenUpdate = cb }
function setOnSessionExpired(cb) { onSessionExpired = cb }

// 계정이 몇 개 등록돼있는지 (세션 보유 기준)
function listAccountIds() {
  return Object.keys(accounts).filter(djId => hasCookies(djId))
}

// 쿠키만으로는 로그인 상태가 재현되지 않는 사이트가 많다 (localStorage에
// 로그인 상태를 별도로 들고 있는 경우). 그래서:
//   1) 먼저 쿠키를 심고 홈으로 가볍게 로드(domcontentloaded)
//   2) 그 문서 컨텍스트에서 localStorage/sessionStorage 주입
//   3) 이후 실제 목적지로 이동(reload 또는 goto) — 이때부터 로그인 상태로 인식됨
async function newAuthenticatedPage(browser, djId) {
  const a = getAccount(djId)
  const page = await browser.newPage()
  await page.setUserAgent(CHROME_UA)
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
  page.setDefaultTimeout(NAV_TIMEOUT_MS)
  if (a.cookies && a.cookies.length) {
    await page.setCookie(...a.cookies)
  }
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })

  if (a.localStorage || a.sessionStorage) {
    await page.evaluate((ls, ss) => {
      try {
        if (ls) for (const k in ls) window.localStorage.setItem(k, ls[k])
        if (ss) for (const k in ss) window.sessionStorage.setItem(k, ss[k])
      } catch (e) { /* ignore */ }
    }, a.localStorage || {}, a.sessionStorage || {})
  }

  return page
}

// 방 입장 시 발급되는 roomToken(x-live-authorization)은 REST API로 직접 발급받을 수 없고,
// 실제로 방 페이지(https://www.spooncast.net/kr/live/{liveId})에 접속했을 때
// 브라우저가 보내는 요청 헤더에서만 얻을 수 있다. (기존 Electron 에디봇과 동일한 원리)
// ⚠️ Railway처럼 자원이 빠듯한 환경에서는 첫 시도가 타임아웃 나는 경우가 종종 있어서,
// 한 번 실패하면 곧바로 한 번 더 시도한다(총 최대 2회). 실제 입장이 걸려있는 중요한 값이라
// 여기서만큼은 재시도 비용을 감수하는 게 낫다.
async function fetchRoomToken(djId, liveId) {
  if (!hasCookies(djId)) {
    console.log(`[tokenManager:${djId}] roomToken 발급 실패: 세션 쿠키 없음`)
    return null
  }
  return withPuppeteerLock(async () => {
    let result = await fetchRoomTokenInner(djId, liveId)
    if (!result) {
      console.log(`[tokenManager:${djId}] roomToken 1차 시도 실패 → 2차 재시도`)
      result = await fetchRoomTokenInner(djId, liveId)
    }
    return result
  })
}

async function fetchRoomTokenInner(djId, liveId) {
  let browser
  try {
    browser = await launchBrowser()
    const page = await newAuthenticatedPage(browser, djId)
    await page.setRequestInterception(true)

    let captured = ''
    page.on('request', (req) => {
      const headers = req.headers()
      const live = headers['x-live-authorization'] || ''
      if (live.startsWith('Bearer ') && live.length > 30) {
        captured = live.slice(7)
        console.log(`[tokenManager:${djId}][diag] x-live-authorization 발견! URL: ${req.url().slice(0, 150)}`)
      }
      req.continue()
    })

    await page.goto(`${ORIGIN}/kr/live/${liveId}`, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS })
    if (!captured) await new Promise((r) => setTimeout(r, 4000))

    const finalUrl = page.url()
    if (/login|signin/i.test(finalUrl)) {
      console.log(`[tokenManager:${djId}] ⚠️ 로그인 화면으로 리다이렉트됨 — 세션이 만료된 것으로 보입니다.`)
    }

    await closeBrowserSafely(browser)
    browser = null

    if (captured) {
      console.log(`[tokenManager:${djId}] ✅ roomToken 발급 성공`)
      return captured
    }
    console.log(`[tokenManager:${djId}] ⚠️ roomToken을 찾지 못했습니다. (로그인 상태 재현 실패이거나 방송이 종료됐을 수 있음)`)
    return null
  } catch (e) {
    console.log(`[tokenManager:${djId}] roomToken 발급 오류:`, e.message)
    return null
  } finally {
    await closeBrowserSafely(browser)
  }
}

async function refreshAccessToken(djId) {
  const a = getAccount(djId)
  if (!hasCookies(djId)) {
    console.log(`[tokenManager:${djId}] 저장된 세션 쿠키가 없습니다. /session/upload 로 먼저 업로드해주세요.`)
    return null
  }
  if (a.refreshing) return a.accessToken
  a.refreshing = true
  try {
    return await withPuppeteerLock(() => refreshAccessTokenInner(djId))
  } finally {
    a.refreshing = false
  }
}

async function refreshAccessTokenInner(djId) {
  const a = getAccount(djId)
  let browser
  try {
    browser = await launchBrowser()
    const page = await newAuthenticatedPage(browser, djId)

    // localStorage 주입 후 다시 로드해야 사이트가 로그인 상태로 인식한다.
    await page.reload({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS })
    // 사이트 자체 로직이 토큰을 조용히 재발급하는 경우를 대비해 약간 대기
    await new Promise((r) => setTimeout(r, 2000))

    const freshCookies = await page.cookies()
    await closeBrowserSafely(browser)
    browser = null

    const atCookie = freshCookies.find(c => c.name === 'spoon_at_kr')

    if (atCookie && atCookie.value) {
      a.accessToken = atCookie.value
      // 다음 갱신을 위해 쿠키 저장소도 최신 상태로 교체 (다른 쿠키들도 회전될 수 있음)
      a.cookies = sanitizeCookies(freshCookies)
      persistToDisk()
      console.log(`[tokenManager:${djId}] ✅ accessToken 갱신 성공`)
      if (onTokenUpdate) onTokenUpdate(djId, a.accessToken)
      return a.accessToken
    }

    console.log(`[tokenManager:${djId}] ⚠️ spoon_at_kr 쿠키를 찾지 못했습니다. 세션이 만료됐을 수 있습니다. (재연결 필요)`)
    if (onSessionExpired) onSessionExpired(djId)
    return null
  } catch (e) {
    console.log(`[tokenManager:${djId}] 갱신 오류:`, e.message)
    if (onSessionExpired) onSessionExpired(djId)
    return null
  } finally {
    await closeBrowserSafely(browser)
  }
}

function startAutoRefresh(djId, intervalMinutes = 10) {
  const a = getAccount(djId)
  if (a.refreshTimer) clearInterval(a.refreshTimer)
  refreshAccessToken(djId) // 업로드 직후 1회 즉시 실행
  a.refreshTimer = setInterval(() => refreshAccessToken(djId), intervalMinutes * 60 * 1000)
}

function stopAutoRefresh(djId) {
  const a = accounts[djId]
  if (a && a.refreshTimer) { clearInterval(a.refreshTimer); a.refreshTimer = null }
}

// startAutoRefresh와 달리, 이미 타이머가 돌고 있으면 건드리지 않는다(=즉시 재실행 안 함).
// PC 자동동기화(2_auto_sync.js)가 자주(예: 25분마다) 세션을 올려주는 경우, 그때마다 서버가
// 매번 Puppeteer를 재실행하면 자원 소모가 커지므로, 이 함수는 "혹시 PC 쪽이 멈췄을 때를 대비한
// 백업용 타이머"만 최초 1회 걸어두는 용도로 쓴다.
function ensureAutoRefresh(djId, intervalMinutes = 10) {
  const a = getAccount(djId)
  if (a.refreshTimer) return // 이미 돌고 있으면 그대로 둠
  a.refreshTimer = setInterval(() => refreshAccessToken(djId), intervalMinutes * 60 * 1000)
}

// 서버 시작 시: initFromDisk()가 돌려준 djId 목록 전부에 대해 자동 갱신을 시작하는 헬퍼
function startAutoRefreshForAll(djIds, intervalMinutes = 10) {
  djIds.forEach(djId => startAutoRefresh(djId, intervalMinutes))
}

module.exports = {
  setCookies,
  hasCookies,
  getCookieHeader,
  getAccessToken,
  fetchRoomToken,
  refreshAccessToken,
  startAutoRefresh,
  stopAutoRefresh,
  ensureAutoRefresh,
  startAutoRefreshForAll,
  setOnTokenUpdate,
  setOnSessionExpired,
  initFromDisk,
  listAccountIds,
}
