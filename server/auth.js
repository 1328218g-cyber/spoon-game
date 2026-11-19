// server/auth.js
// 아주 단순한 토큰 기반 로그인 세션 관리.
// 🔐 로그인 토큰은 DATA_DIR/sessions.json 에도 저장해요 — 서버가 재시작(업데이트 푸시)돼도
//    로그인이 안 풀리고, 자동 로그인으로 그대로 접속돼요 (공식 에디냥처럼).
//    오래(60일) 안 쓴 토큰은 정리하고, 한 계정당 최근 20개까지만 남겨요.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SESSION_FILE = path.join(store.DATA_DIR, 'sessions.json');
const SESSION_TTL_MS = 60 * 864e5;   // 60일 동안 안 쓰면 만료
const SESSION_PER_USER = 20;         // 한 계정당 최근 토큰 20개까지
const TOUCH_EVERY_MS = 3600e3;       // 마지막 사용 시각은 1시간에 한 번만 갱신 (매 요청마다 저장하지 않게)

const tokens = new Map(); // token -> { d: djId, at: 마지막 사용 시각 }

// ── 저장 · 불러오기 ──
function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) || {};
    const now = Date.now();
    for (const [t, v] of Object.entries(raw)) {
      if (v && typeof v.d === 'string' && now - (Number(v.at) || 0) < SESSION_TTL_MS) tokens.set(t, { d: v.d, at: Number(v.at) || now });
    }
    console.log(`[로그인 유지] 저장된 로그인 ${tokens.size}개 불러왔어요`);
  } catch (e) { console.log('[로그인 유지] 불러오기 실패', e.message); }
}
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(store.DATA_DIR)) fs.mkdirSync(store.DATA_DIR, { recursive: true });
      const tmp = SESSION_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(tokens)));
      fs.renameSync(tmp, SESSION_FILE); // (쓰다가 꺼져도 파일이 깨지지 않게)
    } catch (e) { console.log('[로그인 유지] 저장 실패', e.message); }
  }, 3000);
  if (saveTimer.unref) saveTimer.unref();
}
function prune(djId) {
  const now = Date.now();
  for (const [t, v] of tokens) if (now - v.at >= SESSION_TTL_MS) tokens.delete(t);
  if (djId) {
    const mine = [...tokens].filter(([, v]) => v.d === djId).sort((a, b) => b[1].at - a[1].at);
    for (const [t] of mine.slice(SESSION_PER_USER)) tokens.delete(t);
  }
}
loadSessions();
// 서버가 꺼지기 직전에 바로 저장 (업데이트 배포 때)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    try { fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(tokens))); } catch (_) {}
    if (process.listenerCount(sig) === 0) process.exit(0);
  });
}

function issueToken(djId) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { d: djId, at: Date.now() });
  prune(djId);
  saveSoon();
  return token;
}

function verifyToken(token) {
  if (!token) return null;
  const v = tokens.get(token);
  if (!v) return null;
  const now = Date.now();
  if (now - v.at >= SESSION_TTL_MS) { tokens.delete(token); saveSoon(); return null; }
  if (now - v.at >= TOUCH_EVERY_MS) { v.at = now; saveSoon(); }
  return v.d;
}

function revokeToken(token) {
  if (tokens.delete(token)) saveSoon();
}

// Express 미들웨어: Authorization: Bearer <token> 헤더 필요
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const djId = verifyToken(token);
  if (!djId) return res.status(401).json({ success: false, error: '로그인이 필요합니다' });
  if (store.isBlocked(djId)) {
    revokeToken(token);
    return res.status(403).json({ success: false, error: '차단된 계정이에요. 관리자에게 문의해주세요.' });
  }
  req.djId = djId;
  next();
}

// 세션 업로드 등 관리자 전용 기능 보호용.
// 환경변수 ADMIN_KEY가 설정된 경우에만 검사한다 (설정 안 하면 기존처럼 열려있음).
function requireAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return next(); // 설정 안 했으면 통과 (하위호환)
  const given = req.headers['x-admin-key'] || '';
  if (given !== adminKey) return res.status(401).json({ success: false, error: '관리자 인증 실패' });
  next();
}

module.exports = { issueToken, verifyToken, revokeToken, requireAuth, requireAdmin };
