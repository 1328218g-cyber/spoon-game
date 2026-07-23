// server/store.js
// 디제이 계정(아이디/비밀번호)과 디제이별 설정값을 파일에 저장/조회한다.
//
// ⚠️ 중요: DATA_DIR은 기본적으로 이 서버 코드가 있는 폴더 안이라,
// Railway에 새로 배포될 때마다 초기화된다. 가입 정보가 계속 유지되게 하려면
// Railway에 Volume(영구 디스크)을 추가하고, 환경변수 DATA_DIR을
// 그 볼륨 마운트 경로(예: /data)로 지정해야 한다.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DJ_FILE = path.join(DATA_DIR, 'djs.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDjs() {
  ensureDir();
  if (!fs.existsSync(DJ_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DJ_FILE, 'utf-8'));
  } catch (e) {
    console.log('[store] djs.json 읽기 실패:', e.message);
    return {};
  }
}

function saveDjs(djs) {
  ensureDir();
  fs.writeFileSync(DJ_FILE, JSON.stringify(djs, null, 2), 'utf-8');
}

function defaultSettings() {
  return {
    autoJoinTag: '',
    joinMessages: [],
    likeMessages: [],
    entryData: { entry: [], leave: [], like: [], gift: [], repeat: [] },
    entryCooldown: 0,
    funding: {
      cmd: '!펀딩',
      showPercent: true,
      showDday: true,
      titleTemplate: '🎯 진행중인 {month}월 펀딩 🎯',
      itemTemplate: '{index}. {title}\n💰{current}/{goal} [{percent}] {dday}',
      items: [], // { id, title, goal, current, endDate }
    },
    shield: {
      count: 0,
      resetCount: 0,
      cmd: '!실드',
      msgView: '🛡️ 현재 보유 중인 실드는 {실드}개 입니다!',
      msgAdd: '✅ 실드 {amount}개 적립 완료!\n현재 실드: {실드}개',
      msgSub: '▼ 실드 {amount}개 차감 완료!\n현재 실드: {실드}개',
      perms: [],
    },
    flags: {
      cmd: '!깃발',
      items: [], // { id, title, goal, current, mode: 'manual'|'auto', useCycle, template }
    },
  };
}

// 아이디 형식: 영문/숫자/밑줄 2~20자
function validDjId(id) {
  return /^[a-zA-Z0-9_]{2,20}$/.test(id || '');
}

function signup(djId, password) {
  djId = String(djId || '').trim();
  if (!validDjId(djId)) return { ok: false, error: '아이디는 영문/숫자/밑줄 2~20자로 입력해주세요' };
  if (!password || password.length < 4) return { ok: false, error: '비밀번호는 4자 이상이어야 해요' };
  const djs = loadDjs();
  if (djs[djId]) return { ok: false, error: '이미 있는 아이디예요' };
  djs[djId] = {
    passwordHash: bcrypt.hashSync(password, 10),
    settings: defaultSettings(),
    createdAt: Date.now(),
  };
  saveDjs(djs);
  return { ok: true };
}

function login(djId, password) {
  const djs = loadDjs();
  const rec = djs[djId];
  if (!rec) return { ok: false, error: '존재하지 않는 아이디예요' };
  if (rec.blocked) return { ok: false, error: '차단된 계정이에요. 관리자에게 문의해주세요.' };
  if (!bcrypt.compareSync(String(password || ''), rec.passwordHash)) {
    return { ok: false, error: '비밀번호가 틀렸어요' };
  }
  return { ok: true };
}

function setBlocked(djId, blocked) {
  const djs = loadDjs();
  if (!djs[djId]) return false;
  djs[djId].blocked = !!blocked;
  saveDjs(djs);
  return true;
}

function isBlocked(djId) {
  const djs = loadDjs();
  return !!(djs[djId] && djs[djId].blocked);
}

function getSettings(djId) {
  const djs = loadDjs();
  return djs[djId] ? djs[djId].settings : null;
}

function saveSettings(djId, patch) {
  const djs = loadDjs();
  if (!djs[djId]) return false;
  djs[djId].settings = { ...djs[djId].settings, ...patch };
  saveDjs(djs);
  return true;
}

function listDjIds() {
  return Object.keys(loadDjs());
}

// 유저 관리 화면용 요약 정보 (비밀번호 해시는 제외)
function listDjSummaries() {
  const djs = loadDjs();
  return Object.keys(djs).map(id => ({
    djId: id,
    createdAt: djs[id].createdAt || null,
    autoJoinTag: djs[id].settings?.autoJoinTag || '',
    blocked: !!djs[id].blocked,
  }));
}

function exists(djId) {
  const djs = loadDjs();
  return !!djs[djId];
}

module.exports = {
  signup,
  login,
  getSettings,
  saveSettings,
  listDjIds,
  listDjSummaries,
  setBlocked,
  isBlocked,
  exists,
};