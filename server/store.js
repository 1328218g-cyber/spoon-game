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
    autoJoinTags: [], // 다중 감시용 (여러 고유닉)
    autoJoinWatch: false,
    botEnabled: true, // 꺼두면 이 계정은 어떤 봇 명령어/자동멘트에도 반응하지 않는 순수 시청 모드가 된다
    // 사이드바 각 메뉴별 ON/OFF. false로 꺼두면 그 메뉴 화면이 잠기고,
    // 채팅 명령어 처리 로직으로 이어지는 항목(실드/깃발/펀딩/단축키/지정인사/신청곡/
    // 룰렛/애청지수/퀴즈/입장설정/자동입장/채팅)은 실제로도 응답하지 않게 된다.
    moduleEnabled: {
      session: true, userlist: true, autojoin: true, chat: true,
      entrysettings: true, funding: true, shortcuts: true, greet: true,
      flag: true, shield: true, request: true, roulette: true,
      roulettelog: true, autogrant: true, loyalty: true, quiz: true, botreboot: true,
      migrate: true, lottoauto: false, reactiontimer: false, dday: false, raffle: false, dice: false, // ※ 새로 추가되는 모듈은 기본 OFF — 유저가 모듈 마켓에서 직접 찾아 켜야 함
    },
    // 사이드바 각 메뉴를 "화면에 표시할지"만 따로 관리한다. moduleEnabled(기능 자체 켜짐/꺼짐)와는 별개라서,
    // 기능은 계속 켜둔 채로(자동 명령어 등은 그대로 동작) 사이드바만 정리해서 안 보이게 할 수 있다.
    moduleVisible: {
      session: true, userlist: true, autojoin: true, chat: true,
      entrysettings: true, funding: true, shortcuts: true, greet: true,
      flag: true, shield: true, request: true, roulette: true,
      roulettelog: true, autogrant: true, loyalty: true, quiz: true, botreboot: true,
      migrate: true, lottoauto: true, reactiontimer: true, dday: true, raffle: true, dice: true,
    },
    // 이용 만료 관리 — 관리자가 유저 관리 화면에서 계정별로 지정한다.
    // expiresAt(만료 예정 시각, ISO 문자열)이 지나면 입장설정/룰렛기록을 뺀 모든 메뉴가 자동으로 잠긴다.
    // expiryStartAt은 가장 최근에 만료일이 설정된 시점으로, 이용 배너의 진행률 계산에만 쓰인다.
    expiresAt: null,
    expiryStartAt: null,
    joinMessages: [],
    likeMessages: [],
    leaveMessages: [],
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
    commands: [], // { id, trigger, response, scope: 'all'|'manager'|'dj', cooldown, useCount }
    greetings: [], // { id, tag, message } — 특정 고유닉 전용 입장 인사말
    songRequest: {
      accepting: true,
      priorityMode: false,
      showRequester: true,
      cmdRequest: '!신청곡',
      cmdRemove: '!제거',
      cmdReset: '리셋',
      cmdClose: '!마감',
      cmdOpen: '!접수',
      cmdPriorityOn: '!우선온',
      cmdPriorityOff: '!우선오프',
      cmdNameOn: '!이름온',
      cmdNameOff: '!이름오프',
      doneTemplate: '✅ [{artist} - {title}] 신청 완료! (대기: {count}번)',
      listTitle: '🎵 현재 신청곡 목록 🎵',
      listItemTemplate: '{index}. {artist} - {title}',
      maxCharsPerMsg: 100,
      msgIntervalMs: 600,
      items: [], // { id, artist, title, requester }
    },
    roulette: {
      list: [], // { id, name, triggerMode: 'exact'|'combo'|'distribute', triggerAmount, items: [{id, name, percent, skipHistory}] }
      resultHeaderTemplate: '[🎡{룰렛명}] {닉네임}님 당첨! 🎉',
      couponUseTemplate: '🎡 {닉네임}님이 룰렛{번호} 권 {수량}개를 사용했습니다! (잔여: {잔여}개)',
      couponLowTemplate: '🎡 {닉네임}님, 룰렛{번호}({룰렛명}) 권이 부족합니다.',
    },
    rouletteHistory: {}, // { [tag]: { coupons: {}, wins: [], keepList: {name:count}, miscList: {}, eventList: {} } }
  };
}

// 아이디 형식: 영문/숫자/밑줄 2~20자
function validDjId(id) {
  return /^[a-zA-Z0-9_]{2,20}$/.test(id || '');
}

// 신규 회원가입 시 자동으로 부여되는 기본 이용기간(일수)을 관리한다. 관리자(sum) 계정의
// settings.defaultTrialDays에 저장해두고, signup()이 새 계정을 만들 때 이 값을 읽어서 적용한다.
// 값이 없으면(처음 세팅 전) 기본 4일을 쓴다. 0으로 설정하면 신규가입자도 처음부터 무제한.
function getDefaultTrialDays() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.defaultTrialDays;
  return (typeof v === 'number' && v >= 0) ? v : 4;
}

function setDefaultTrialDays(days) {
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: '0 이상의 숫자를 입력해주세요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  djs['sum'].settings.defaultTrialDays = n;
  saveDjs(djs);
  return { ok: true };
}

function signup(djId, password, referrerId) {
  djId = String(djId || '').trim();
  if (!validDjId(djId)) return { ok: false, error: '아이디는 영문/숫자/밑줄 2~20자로 입력해주세요' };
  if (!password || password.length < 4) return { ok: false, error: '비밀번호는 4자 이상이어야 해요' };
  const djs = loadDjs();
  if (djs[djId]) return { ok: false, error: '이미 있는 아이디예요' };

  // 추천인 고유닉은 선택 사항. 입력했다면 실제로 존재하는 계정인지, 본인 아이디는 아닌지 확인한다.
  let cleanReferrer = null;
  const rawReferrer = String(referrerId || '').trim().replace(/^@/, '');
  if (rawReferrer) {
    if (rawReferrer.toLowerCase() === djId.toLowerCase()) {
      return { ok: false, error: '본인 아이디는 추천인으로 입력할 수 없어요' };
    }
    if (!djs[rawReferrer]) {
      return { ok: false, error: '존재하지 않는 추천인 고유닉이에요' };
    }
    cleanReferrer = rawReferrer;
  }

  // 최초 가입 시 기본 이용기간은 관리자가 설정한 일수(초기값 4일)로 적용한다 (관리자 sum 계정은 예외로 무제한).
  // 0으로 설정해두면 신규가입자도 처음부터 무제한으로 시작한다. 이후 관리자가 유저 관리 화면에서
  // 개별 유저의 만료일을 언제든 연장/해제할 수 있다.
  const settings = defaultSettings();
  if (djId !== 'sum') {
    const trialDays = getDefaultTrialDays();
    if (trialDays > 0) {
      const now = Date.now();
      settings.expiresAt = new Date(now + trialDays * 24 * 60 * 60 * 1000).toISOString();
      settings.expiryStartAt = new Date(now).toISOString();
    }
  }

  djs[djId] = {
    passwordHash: bcrypt.hashSync(password, 10),
    settings,
    createdAt: Date.now(),
    blocked: false,
    autoJoinEnabled: true, // 다중감시(자동입장)는 이제 별도 관리자 권한 없이 누구나 기본 사용 가능
    referrerId: cleanReferrer, // 가입 시 입력한 추천인 고유닉 (없으면 null)
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

// 로그인된 본인이 "내정보"에서 아이디/비밀번호를 바꿀 때, 본인 확인용으로 현재 비밀번호를 검증한다.
function verifyPassword(djId, password) {
  const djs = loadDjs();
  const rec = djs[djId];
  if (!rec) return false;
  return bcrypt.compareSync(String(password || ''), rec.passwordHash);
}

// 비밀번호만 변경 (아이디는 그대로 유지)
function changePassword(djId, newPassword) {
  const djs = loadDjs();
  if (!djs[djId]) return { ok: false, error: '유저를 찾을 수 없어요' };
  if (!newPassword || String(newPassword).length < 4) return { ok: false, error: '비밀번호는 4자 이상이어야 해요' };
  djs[djId].passwordHash = bcrypt.hashSync(String(newPassword), 10);
  saveDjs(djs);
  return { ok: true };
}

// 헷갈리기 쉬운 문자(0/O, 1/l/I)는 빼고 무작위 임시 비밀번호를 만든다.
function generateRandomPassword(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < length; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

// 비밀번호 찾기(관리자 대신 재설정용) — 이메일 인증 체계가 없어서 본인 확인 후 관리자가
// 직접 새 비밀번호를 발급해 유저에게 전달해주는 방식으로 운영한다. 관리자 계정(sum)은 대상에서 제외.
function resetPasswordRandom(djId) {
  const djs = loadDjs();
  if (!djs[djId]) return { ok: false, error: '유저를 찾을 수 없어요' };
  if (djId === 'sum') return { ok: false, error: '관리자 계정은 여기서 재설정할 수 없어요' };
  const newPassword = generateRandomPassword(8);
  djs[djId].passwordHash = bcrypt.hashSync(newPassword, 10);
  saveDjs(djs);
  return { ok: true, newPassword };
}

// 아이디(로그인 키)를 변경한다. 설정/가입일/차단여부 등은 그대로 새 아이디로 옮겨간다.
// 관리자 계정 'sum'은 여러 곳에 하드코딩되어 있어(공용 스푼 토큰, 관리자 권한 체크 등) 변경을 허용하지 않는다.
function renameDjId(oldId, newId) {
  const djs = loadDjs();
  if (!djs[oldId]) return { ok: false, error: '유저를 찾을 수 없어요' };
  if (oldId === 'sum') return { ok: false, error: '관리자 계정은 아이디를 변경할 수 없어요' };
  if (!validDjId(newId)) return { ok: false, error: '아이디는 영문/숫자/밑줄 2~20자로 입력해주세요' };
  if (newId === 'sum') return { ok: false, error: '그 아이디는 사용할 수 없어요' };
  if (oldId === newId) return { ok: false, error: '현재 아이디와 같아요' };
  if (djs[newId]) return { ok: false, error: '이미 사용 중인 아이디예요' };
  djs[newId] = djs[oldId];
  delete djs[oldId];
  saveDjs(djs);
  return { ok: true };
}

function setBlocked(djId, blocked) {
  const djs = loadDjs();
  if (!djs[djId]) return false;
  djs[djId].blocked = !!blocked;
  saveDjs(djs);
  return true;
}

function deleteDj(djId) {
  const djs = loadDjs();
  if (!djs[djId]) return false;
  delete djs[djId];
  saveDjs(djs);
  return true;
}

// ⚠️ 계정(아이디/비밀번호/가입일/차단여부/자동입장허용여부)은 그대로 두고,
// 봇 설정 데이터(실드/깃발/펀딩/신청곡/룰렛/애청지수/명령어/지정인사/입장설정 등)만
// 최초 가입 시 상태(defaultSettings)로 되돌린다. 관리자의 "계정별 리셋" 버튼에서 사용.
function resetSettings(djId) {
  const djs = loadDjs();
  if (!djs[djId]) return false;
  djs[djId].settings = defaultSettings();
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
    autoJoinEnabled: !!djs[id].autoJoinEnabled,
    expiresAt: djs[id].settings?.expiresAt || null,
    referrerId: djs[id].referrerId || null,
  }));
}

function setAutoJoinEnabled(djId, enabled) {
  const djs = loadDjs();
  if (!djs[djId]) return false;
  djs[djId].autoJoinEnabled = !!enabled;
  saveDjs(djs);
  return true;
}

function getAutoJoinEnabled(djId) {
  const djs = loadDjs();
  return !!(djs[djId] && djs[djId].autoJoinEnabled);
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
  deleteDj,
  resetSettings,
  isBlocked,
  setAutoJoinEnabled,
  getAutoJoinEnabled,
  exists,
  verifyPassword,
  changePassword,
  renameDjId,
  getDefaultTrialDays,
  setDefaultTrialDays,
};