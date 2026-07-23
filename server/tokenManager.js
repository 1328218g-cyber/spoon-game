// server/tokenManager.js
// PC에서 추출한 세션 쿠키를 이용해, 서버가 스스로 accessToken을
// 주기적으로 재발급받아 유지하는 모듈. (구글/카카오/페북 로그인을
// 서버가 직접 자동화하지 않고, 이미 로그인된 세션을 재사용하는 방식)

const puppeteer = require('puppeteer');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let sessionCookies = null;      // 업로드된 쿠키 배열
let currentAccessToken = '';    // 캡처된 최신 accessToken
let refreshTimer = null;
let refreshing = false;
let onTokenUpdate = null;       // 토큰 갱신 성공 시 콜백 (index.js에서 등록)
let onSessionExpired = null;    // 세션 만료(재로그인 필요) 감지 시 콜백

// Chrome 개발자도구/확장으로 내보낸 쿠키 JSON에는 puppeteer의 setCookie()가
// 모르는 필드(size 등)가 섞여 있을 수 있어, 필요한 필드만 남기고 정리한다.
function sanitizeCookies(cookies) {
  return cookies
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

function setCookies(cookies) {
  sessionCookies = sanitizeCookies(cookies || []);
}

function hasCookies() {
  return !!(sessionCookies && sessionCookies.length > 0);
}

function getAccessToken() {
  return currentAccessToken;
}

function setOnTokenUpdate(cb) { onTokenUpdate = cb; }
function setOnSessionExpired(cb) { onSessionExpired = cb; }

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
    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.setCookie(...sessionCookies);
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

    await page.goto(`https://www.spooncast.net/kr/live/${liveId}`, { waitUntil: 'networkidle2', timeout: 30000 });
    if (!captured) await new Promise((r) => setTimeout(r, 2500));

    await browser.close();
    browser = null;

    if (captured) {
      console.log('[tokenManager] ✅ roomToken 발급 성공');
      return captured;
    }
    console.log('[tokenManager] ⚠️ roomToken을 찾지 못했습니다. (방송이 이미 종료됐거나 접근 권한 문제일 수 있음)');
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
    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.setCookie(...sessionCookies);

    // 요청 헤더를 가로채는 대신, 방문 후 브라우저에 저장된 쿠키를 직접 읽는다.
    // 스푼은 accessToken 자체를 spoon_at_kr 쿠키 값으로 사용하므로
    // 이 쿠키만 읽으면 API 호출 발생 여부와 상관없이 안정적으로 토큰을 얻을 수 있다.
    await page.goto('https://www.spooncast.net', { waitUntil: 'networkidle2', timeout: 30000 });
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
