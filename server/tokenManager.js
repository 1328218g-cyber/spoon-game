// server/tokenManager.js
// PC에서 추출한 세션 쿠키 + localStorage/sessionStorage를 이용해,
// 서버가 스스로 accessToken/roomToken을 재발급받아 유지하는 모듈.
// (구글/카카오/페북 로그인을 서버가 직접 자동화하지 않고,
//  이미 로그인된 세션을 그대로 재사용하는 방식)

const puppeteer = require('puppeteer');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.spooncast.net';

let sessionCookies = null;         // 업로드된 쿠키 배열
let storedLocalStorage = null;     // 업로드된 localStorage 스냅샷
let storedSessionStorage = null;   // 업로드된 sessionStorage 스냅샷
let currentAccessToken = '';       // 캡처된 최신 accessToken
let refreshTimer = null;
let refreshing = false;
let onTokenUpdate = null;          // 토큰 갱신 성공 시 콜백 (index.js에서 등록)
let onSessionExpired = null;       // 세션 만료(재로그인 필요) 감지 시 콜백

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
      };
      if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
      if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') out.sameSite = c.sameSite;
      return out;
    });
}

// data: get_session_cookies.js가 만든 { cookies, localStorage, sessionStorage } 객체.
// 구버전 파일(쿠키 배열만)도 하위호환으로 허용.
function setCookies(data) {
  if (Array.isArray(data)) {
    sessionCookies = sanitizeCookies(data);
    storedLocalStorage = null;
    storedSessionStorage = null;
    return;
  }
  sessionCookies = sanitizeCookies(data && data.cookies);
  storedLocalStorage = (data && data.localStorage) || null;
  storedSessionStorage = (data && data.sessionStorage) || null;
}

function hasCookies() {
  return !!(sessionCookies && sessionCookies.length > 0);
}

function getAccessToken() {
  return currentAccessToken;
}

function setOnTokenUpdate(cb) { onTokenUpdate = cb; }
function setOnSessionExpired(cb) { onSessionExpired = cb; }

// 쿠키만으로는 로그인 상태가 재현되지 않는 사이트가 많다 (localStorage에
// 로그인 상태를 별도로 들고 있는 경우). 그래서:
//   1) 먼저 쿠키를 심고 홈으로 가볍게 로드(domcontentloaded)
//   2) 그 문서 컨텍스트에서 localStorage/sessionStorage 주입
//   3) 이후 실제 목적지로 이동(reload 또는 goto) — 이때부터 로그인 상태로 인식됨
async function newAuthenticatedPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(CHROME_UA);
  if (sessionCookies && sessionCookies.length) {
    await page.setCookie(...sessionCookies);
  }
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (storedLocalStorage || storedSessionStorage) {
    await page.evaluate((ls, ss) => {
      try {
        if (ls) for (const k in ls) window.localStorage.setItem(k, ls[k]);
        if (ss) for (const k in ss) window.sessionStorage.setItem(k, ss[k]);
      } catch (e) { /* ignore */ }
    }, storedLocalStorage || {}, storedSessionStorage || {});
  }

  return page;
}

// 방 입장 시 발급되는 roomToken(x-live-authorization)은 REST API로 직접 발급받을 수 없고,
// 실제로 방 페이지(https://www.spooncast.net/kr/live/{liveId})에 접속했을 때
// 브라우저가 보내는 요청 헤더에서만 얻을 수 있다. (기존 Electron 에디봇과 동일한 원리)
async function fetchRoomToken(liveId) {
  if (!hasCookies()) {
    console.log('[tokenManager] roomToken 발급 실패: 세션 쿠키 없음');
    return null;
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await newAuthenticatedPage(browser);
    await page.setRequestInterception(true);

    let captured = '';
    page.on('request', (req) => {
      const headers = req.headers();
      const live = headers['x-live-authorization'] || '';
      if (live.startsWith('Bearer ') && live.length > 30) {
        captured = live.slice(7);
      }
      req.continue();
    });

    // 진단용: 방 관련 API 응답 상태코드를 로그로 남긴다 (원인 파악용)
    page.on('response', (res) => {
      const u = res.url();
      if (u.includes('/lives/') || u.includes('/entrance') || u.includes('/auth')) {
        console.log(`[tokenManager][diag] ${res.status()} ${u.slice(0, 120)}`);
      }
    });

    await page.goto(`${ORIGIN}/kr/live/${liveId}`, { waitUntil: 'networkidle2', timeout: 30000 });
    if (!captured) await new Promise((r) => setTimeout(r, 4000));

    const finalUrl = page.url();
    console.log('[tokenManager][diag] 최종 페이지 URL:', finalUrl);
    if (/login|signin/i.test(finalUrl)) {
      console.log('[tokenManager] ⚠️ 로그인 화면으로 리다이렉트됨 — 세션이 만료된 것으로 보입니다.');
    }

    await browser.close();
    browser = null;

    if (captured) {
      console.log('[tokenManager] ✅ roomToken 발급 성공');
      return captured;
    }
    console.log('[tokenManager] ⚠️ roomToken을 찾지 못했습니다. (로그인 상태 재현 실패이거나 방송이 종료됐을 수 있음)');
    return null;
  } catch (e) {
    console.log('[tokenManager] roomToken 발급 오류:', e.message);
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}

async function refreshAccessToken() {
  if (!hasCookies()) {
    console.log('[tokenManager] 저장된 세션 쿠키가 없습니다. /session/upload 로 먼저 업로드해주세요.');
    return null;
  }
  if (refreshing) return currentAccessToken;
  refreshing = true;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await newAuthenticatedPage(browser);

    // localStorage 주입 후 다시 로드해야 사이트가 로그인 상태로 인식한다.
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    // 사이트 자체 로직이 토큰을 조용히 재발급하는 경우를 대비해 약간 대기
    await new Promise((r) => setTimeout(r, 2000));

    const freshCookies = await page.cookies();
    await browser.close();
    browser = null;

    const atCookie = freshCookies.find(c => c.name === 'spoon_at_kr');

    if (atCookie && atCookie.value) {
      currentAccessToken = atCookie.value;
      // 다음 갱신을 위해 쿠키 저장소도 최신 상태로 교체 (다른 쿠키들도 회전될 수 있음)
      sessionCookies = sanitizeCookies(freshCookies);
      console.log('[tokenManager] ✅ accessToken 갱신 성공');
      if (onTokenUpdate) onTokenUpdate(currentAccessToken);
      return currentAccessToken;
    }

    console.log('[tokenManager] ⚠️ spoon_at_kr 쿠키를 찾지 못했습니다. 세션이 만료됐을 수 있습니다. (PC에서 재로그인 필요)');
    if (onSessionExpired) onSessionExpired();
    return null;
  } catch (e) {
    console.log('[tokenManager] 갱신 오류:', e.message);
    if (onSessionExpired) onSessionExpired();
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    refreshing = false;
  }
}

function startAutoRefresh(intervalMinutes = 10) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshAccessToken(); // 업로드 직후 1회 즉시 실행
  refreshTimer = setInterval(refreshAccessToken, intervalMinutes * 60 * 1000);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

module.exports = {
  setCookies,
  hasCookies,
  getAccessToken,
  fetchRoomToken,
  refreshAccessToken,
  startAutoRefresh,
  stopAutoRefresh,
  setOnTokenUpdate,
  setOnSessionExpired,
};
