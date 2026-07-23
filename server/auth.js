// server/auth.js
// 아주 단순한 토큰 기반 로그인 세션 관리.
// 서버가 재시작되면 토큰은 초기화되므로(=재로그인 필요) 데이터 자체가
// 날아가지는 않는다 (계정/설정은 store.js가 파일에 저장).

const crypto = require('crypto');

const tokens = new Map(); // token -> djId

function issueToken(djId) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, djId);
  return token;
}

function verifyToken(token) {
  return tokens.get(token) || null;
}

function revokeToken(token) {
  tokens.delete(token);
}

// Express 미들웨어: Authorization: Bearer <token> 헤더 필요
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const djId = verifyToken(token);
  if (!djId) return res.status(401).json({ success: false, error: '로그인이 필요합니다' });
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
