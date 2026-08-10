// server/store.js
// 디제이 계정(아이디/비밀번호)과 디제이별 설정값을 파일에 저장/조회한다.
//
// ⚠️ 중요: DATA_DIR은 기본적으로 이 서버 코드가 있는 폴더 안이라,
// Railway에 새로 배포될 때마다 초기화된다. 가입 정보가 계속 유지되게 하려면
// Railway에 Volume(영구 디스크)을 추가하고, 환경변수 DATA_DIR을
// 그 볼륨 마운트 경로(예: /data)로 지정해야 한다.
//
// ⚡ 성능 메모: 예전엔 이 파일의 모든 함수가 호출될 때마다 djs.json 전체를 동기로
// 읽고 파싱했다. DJ 수가 늘어나면서 여러 setInterval 루프(반복문구 10초, 경매 20초 등)가
// 계정 수만큼 이 파일을 반복해서 읽어들이는 상황이 겹쳐 이벤트 루프가 막히고,
// 그 사이 /auth/login 같은 요청이 몇 분씩 밀리는 문제가 있었다. 그래서 인메모리 캐시를
// 두고, 쓰기(saveDjs)가 일어날 때만 디스크에 반영하도록 바꿨다.
// 여러 프로세스가 같은 DATA_DIR을 동시에 쓰는 구조가 아니므로 캐시가 안전하다.
//
// 🚨 사고 기록(2026-08): 저장 도중(fs.writeFileSync) 서버가 죽으면서 djs.json이 통째로
// 0바이트가 돼버려 전체 계정 데이터가 유실된 적이 있다. writeFileSync는 원자적이지
// 않아서, 쓰는 도중에 프로세스가 죽으면 파일이 반쯤 쓰이거나 완전히 비어버릴 수 있다.
// 그래서 지금은: (1) 임시 파일에 먼저 쓰고 다 쓰인 뒤에만 원본 이름으로 바꿔치기(rename —
// 이건 운영체제 차원에서 원자적이라 중간 상태가 존재할 수 없다), (2) 몇 시간에 한 번씩
// 타임스탬프 붙은 백업을 따로 남겨서, 혹시 또 문제가 생겨도 되돌릴 지점을 확보해둔다.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DJ_FILE = path.join(DATA_DIR, 'djs.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP_COUNT = 20; // 최근 20개까지만 보관 (그 이상 오래된 건 자동 삭제)

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// 손상된 djs.json을 만났을 때, 가장 최근 백업으로 자동 복구를 시도한다.
function tryRestoreFromLatestBackup() {
  try {
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('djs-')).sort().reverse();
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf-8'));
        console.log(`[store] 🚨 djs.json 손상 감지 → 백업(${f})에서 자동 복구했어요.`);
        return parsed;
      } catch (e) { /* 이 백업도 손상됐으면 다음(더 예전) 백업 시도 */ }
    }
  } catch (e) { /* 백업 폴더 자체가 없거나 문제있으면 그냥 포기 */ }
  return null;
}

let _cache = null; // 최초 로드 이후엔 메모리에서만 읽는다

function loadDjs() {
  if (_cache) return _cache;
  ensureDir();
  if (!fs.existsSync(DJ_FILE)) {
    _cache = {};
    return _cache;
  }
  try {
    const raw = fs.readFileSync(DJ_FILE, 'utf-8');
    if (!raw || !raw.trim()) throw new Error('파일이 비어있음');
    _cache = JSON.parse(raw);
  } catch (e) {
    console.log('[store] djs.json 읽기 실패:', e.message);
    const restored = tryRestoreFromLatestBackup();
    _cache = restored || {};
    if (restored) saveDjs(_cache) // 복구된 걸 즉시 원본 자리에도 반영해둔다
  }
  return _cache;
}

// 원자적 저장 — 임시 파일에 먼저 다 쓴 다음, 원본 이름으로 바꿔치기(rename)한다.
// rename은 운영체제 차원에서 원자적이라, 쓰는 도중 프로세스가 죽어도 djs.json은
// 항상 "완전한 예전 버전" 아니면 "완전한 새 버전" 둘 중 하나만 유지된다.
function saveDjs(djs) {
  ensureDir();
  _cache = djs; // 캐시 갱신
  const json = JSON.stringify(djs, null, 2);
  const tmpFile = DJ_FILE + '.tmp';
  fs.writeFileSync(tmpFile, json, 'utf-8');
  fs.renameSync(tmpFile, DJ_FILE);
}

// 🗂️ 주기적 백업 — 타임스탬프 붙여서 backups/ 폴더에 스냅샷을 남긴다.
function createBackupSnapshot() {
  try {
    if (!_cache) return
    ensureBackupDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = path.join(BACKUP_DIR, `djs-${stamp}.json`)
    fs.writeFileSync(backupFile, JSON.stringify(_cache, null, 2), 'utf-8')
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('djs-')).sort()
    while (files.length > BACKUP_KEEP_COUNT) {
      const oldest = files.shift()
      try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)) } catch (e) {}
    }
  } catch (e) {
    console.log('[store] 백업 생성 실패:', e.message)
  }
}

// 채팅 한 줄마다 호출되는 것처럼 아주 잦은 이벤트에서 매번 saveSettings()로 디스크에 즉시
// 쓰면(=saveDjs 매번 호출) 전체 djs.json을 통째로 다시 쓰는 동기 작업이 반복돼서 이벤트 루프가
// 막히고 명령어 반응이 느려진다. 이런 곳은 getSettings()로 받은 객체를 직접 수정만 해두고
// (참조라서 캐시에는 바로 반영됨), 이 flush()를 주기적으로 한 번씩만 불러서 디스크에 반영한다.
function flush() {
  if (_cache) saveDjs(_cache);
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
      migrate: true, lottoauto: false, reactiontimer: false, dday: false, raffle: false, dice: false, soundfx: false, tts: false, dashboard: false, wheelroulette: false, couponcheck: false, usernotes: false, discordnotify: false, fishing: false, // ※ 새로 추가되는 모듈은 기본 OFF — 유저가 모듈 마켓에서 직접 찾아 켜야 함
    },
    // 사이드바 각 메뉴를 "화면에 표시할지"만 따로 관리한다. moduleEnabled(기능 자체 켜짐/꺼짐)와는 별개라서,
    // 기능은 계속 켜둔 채로(자동 명령어 등은 그대로 동작) 사이드바만 정리해서 안 보이게 할 수 있다.
    moduleVisible: {
      session: true, userlist: true, autojoin: true, chat: true,
      entrysettings: true, funding: true, shortcuts: true, greet: true,
      flag: true, shield: true, request: true, roulette: true,
      roulettelog: true, autogrant: true, loyalty: true, quiz: true, botreboot: true,
      migrate: true, lottoauto: true, reactiontimer: true, dday: true, raffle: true, dice: true, soundfx: true, tts: true, dashboard: true, wheelroulette: true, couponcheck: true, usernotes: true, discordnotify: true, fishing: true,
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

// ⚡ 요청 모듈(특정 유저만 접근 가능한 제한 메뉴) 레지스트리.
// 관리자(sum) 계정의 settings.requestModules에 배열로 저장해서 중앙 관리한다.
// 각 항목: { id, title, icon, targetPanel, allowedDjIds: [djId, ...] }
function getRequestModules() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.requestModules;
  return Array.isArray(v) ? v : [];
}

function saveRequestModules(list) {
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  djs['sum'].settings.requestModules = Array.isArray(list) ? list : [];
  saveDjs(djs);
  return { ok: true };
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// ⚡ 중복 가입 방지 — 같은 기기(브라우저에 저장된 deviceId) 또는 같은 IP로 이미 가입한 계정이
// 있으면 신규 가입을 막는다. 완벽하진 않다(시크릿모드+VPN이면 우회 가능)는 걸 감안하고,
// "귀찮게 만드는" 수준의 억제책으로 사용한다. 관리자가 IP 허용목록에 등록해두면(피시방/가족 와이파이
// 등 여러 명이 같은 IP를 쓰는 경우) 그 IP는 중복 체크에서 제외된다.
function getDuplicateCheckAllowedIps() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.duplicateCheckAllowedIps;
  return Array.isArray(v) ? v : [];
}
function addDuplicateCheckAllowedIp(ip) {
  const clean = String(ip || '').trim();
  if (!clean) return { ok: false, error: 'IP를 입력해주세요' };
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  const list = Array.isArray(djs['sum'].settings.duplicateCheckAllowedIps) ? djs['sum'].settings.duplicateCheckAllowedIps : [];
  if (!list.includes(clean)) list.push(clean);
  djs['sum'].settings.duplicateCheckAllowedIps = list;
  saveDjs(djs);
  return { ok: true };
}
function removeDuplicateCheckAllowedIp(ip) {
  const djs = loadDjs();
  if (!djs['sum'] || !djs['sum'].settings) return { ok: false, error: '관리자 계정이 아직 없어요' };
  const list = Array.isArray(djs['sum'].settings.duplicateCheckAllowedIps) ? djs['sum'].settings.duplicateCheckAllowedIps : [];
  djs['sum'].settings.duplicateCheckAllowedIps = list.filter(x => x !== ip);
  saveDjs(djs);
  return { ok: true };
}

// 📢 업데이트 공지 — 관리자가 등록하면, 유저가 로그인할 때 팝업으로 한 번 보여준다.
// (관리자 계정의 settings 안에 저장해두고, 각 유저는 자기 settings에 마지막으로 본 공지 id를 기록해서
//  다음에 접속했을 때 이미 본 공지면 다시 안 뜨게 한다)
// 등록할 때마다 announcementHistory에도 같이 쌓아서, 유저가 지난 공지들을 "업데이트 내역"에서 볼 수 있게 한다.
function getAnnouncement() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.announcement;
  return v && v.id ? v : null;
}
function getAnnouncementHistory() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.announcementHistory;
  return Array.isArray(v) ? v : [];
}
function setAnnouncement(title, content) {
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  const announcement = { id: Date.now(), title: String(title || '').trim(), content: String(content || '').trim(), createdAt: Date.now() };
  djs['sum'].settings.announcement = announcement;
  const history = Array.isArray(djs['sum'].settings.announcementHistory) ? djs['sum'].settings.announcementHistory : [];
  history.unshift(announcement) // 최신이 맨 앞
  djs['sum'].settings.announcementHistory = history.slice(0, 50) // 최근 50개까지만 보관
  saveDjs(djs);
  return { ok: true, announcement };
}

// 🚨 서비스 상태 배너 — 점검/장애 등 안내를 사이드바 상단에 항상 떠있는 배너로 표시한다.
// (업데이트 공지 팝업과 달리 "확인" 눌러도 안 사라지고, 관리자가 끌 때까지 계속 보임)
function getStatusBanner() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.statusBanner;
  return v && v.enabled ? v : null;
}
function setStatusBanner(enabled, message, type) {
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  djs['sum'].settings.statusBanner = { enabled: !!enabled, message: String(message || '').trim(), type: ['warning', 'info', 'danger'].includes(type) ? type : 'warning', updatedAt: Date.now() };
  saveDjs(djs);
  return { ok: true, banner: djs['sum'].settings.statusBanner };
}

// 📊 관리자 대시보드용 요약 통계
function getAdminStats() {
  const djs = loadDjs();
  const ids = Object.keys(djs).filter(id => id !== 'sum');
  const now = Date.now();
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  let activeToday = 0, autoJoinWatching = 0, expired = 0, blocked = 0
  for (const id of ids) {
    const rec = djs[id];
    if (rec.lastLoginAt && rec.lastLoginAt >= today0.getTime()) activeToday++
    const s = rec.settings || {}
    if (s.autoJoinWatch) autoJoinWatching++
    if (s.expiresAt && now > new Date(s.expiresAt).getTime()) expired++
    if (rec.blocked) blocked++
  }
  return { totalDjs: ids.length, activeToday, autoJoinWatching, expired, blocked }
}

// 가입 전 미리 체크용 — 겹치는 기존 계정의 djId를 반환한다(없으면 null).
function findDuplicateSignup(signupIp, deviceId) {
  const djs = loadDjs();
  const allowedIps = getDuplicateCheckAllowedIps();
  const ipOk = signupIp && !allowedIps.includes(signupIp);
  for (const id of Object.keys(djs)) {
    if (id === 'sum') continue;
    const rec = djs[id];
    if (deviceId && rec.signupDeviceId && rec.signupDeviceId === deviceId) return id;
    if (ipOk && signupIp && rec.signupIp === signupIp) return id;
  }
  return null;
}

function signup(djId, password, djTag, email, signupIp, deviceId, skipDupCheck = false) {
  djId = String(djId || '').trim();
  if (!validDjId(djId)) return { ok: false, error: '아이디는 영문/숫자/밑줄 2~20자로 입력해주세요' };
  if (!password || password.length < 4) return { ok: false, error: '비밀번호는 4자 이상이어야 해요' };
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!validEmail(cleanEmail)) return { ok: false, error: '비밀번호 찾기에 사용할 이메일을 올바르게 입력해주세요' };
  const djs = loadDjs();
  if (djs[djId]) return { ok: false, error: '이미 있는 아이디예요' };

  if (!skipDupCheck) {
    const dupId = findDuplicateSignup(signupIp, deviceId);
    if (dupId) return { ok: false, error: '이미 가입 기록이 있는 기기 또는 네트워크예요. 중복 가입은 제한돼요. 오해라면(피시방/공용 와이파이 등) 관리자에게 문의해주세요.' };
  }

  // 디제이 고유닉은 필수. 가입 즉시 다중감시(자동입장) 목록에 자동으로 등록해서,
  // 로그인 후 별도 설정 없이도 자동입장이 바로 동작하게 한다.
  const cleanTag = String(djTag || '').trim().replace(/^@/, '');
  if (!cleanTag) return { ok: false, error: '디제이 고유닉을 입력해주세요 (자동입장에 사용돼요)' };

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

  // 가입한 고유닉을 다중감시 목록에 바로 등록해서, 로그인 직후 자동입장 화면에서 별도 설정 없이 동작하게 한다.
  settings.autoJoinTags = [cleanTag];
  settings.autoJoinWatch = true;
  settings.autoJoinTag = cleanTag;
  // 🔒 가입 시 등록한 이 고유닉을 "본인 방"으로 바로 잠근다. 남의 방으로 계속 바꿔가며
  // 봇을 옮겨다니는 걸 막기 위함 — 이후 다른 고유닉으로 바꾸려면 2일이 지나야 한다.
  settings.autoJoinLockedTags = [cleanTag];
  settings.autoJoinTagLockedAt = Date.now();

  // 입장/좋아요 인사말은 기본으로 하나씩 켜둬서, 별도 설정 없이도 바로 인사멘트가 나가게 한다.
  settings.entryData = {
    entry: [{ id: 1, enabled: true, target: '', text: '{nickname}님 어서오세요! 🎉', delay: 1, sound: '' }],
    leave: [],
    like: [{ id: 1, enabled: true, target: '', text: '{nickname}님 좋아요 감사해요! ❤️', delay: 1, sound: '' }],
    gift: [],
    repeat: [],
  };

  djs[djId] = {
    passwordHash: bcrypt.hashSync(password, 10),
    email: cleanEmail, // 비밀번호 찾기 본인확인용
    settings,
    createdAt: Date.now(),
    blocked: false,
    autoJoinEnabled: true, // 다중감시(자동입장)는 이제 별도 관리자 권한 없이 누구나 기본 사용 가능
    djTag: cleanTag, // 가입 시 등록한 본인 디제이 고유닉
    signupIp: signupIp || null,       // 중복 가입 감지용
    signupDeviceId: deviceId || null, // 중복 가입 감지용 (브라우저에 저장된 임의 식별자)
  };
  saveDjs(djs);
  return { ok: true };
}

// ⚡ 비동기로 변경: bcrypt.compareSync는 이벤트 루프를 그대로 막아버려서,
// 여러 계정이 동시에 로그인 요청을 보내면(자동 세션 동기화 등) 요청들이 줄줄이 밀리는
// 문제가 있었다. bcrypt.compare(비동기 버전)로 바꿔서 다른 요청 처리를 막지 않게 한다.
async function login(djId, password) {
  const djs = loadDjs();
  const rec = djs[djId];
  if (!rec) return { ok: false, error: '존재하지 않는 아이디예요' };
  if (rec.blocked) return { ok: false, error: '차단된 계정이에요. 관리자에게 문의해주세요.' };
  const match = await bcrypt.compare(String(password || ''), rec.passwordHash);
  if (!match) return { ok: false, error: '비밀번호가 틀렸어요' };
  rec.lastLoginAt = Date.now(); // ⏰ 마지막 접속일 기록 (관리자 유저 관리 화면 + 장기 미접속 자동정리에 사용)
  saveDjs(djs);
  return { ok: true };
}

// 로그인된 본인이 "내정보"에서 아이디/비밀번호를 바꿀 때, 본인 확인용으로 현재 비밀번호를 검증한다.
async function verifyPassword(djId, password) {
  const djs = loadDjs();
  const rec = djs[djId];
  if (!rec) return false;
  return bcrypt.compare(String(password || ''), rec.passwordHash);
}

// 비밀번호 찾기 — 가입할 때 등록해둔 이메일과 지금 입력한 이메일이 일치하는지 확인한다.
// ⚠️ 실제로 그 이메일 주소로 인증코드를 발송하는 건 아니고(이메일 발송 서버가 없음),
// "가입할 때 적은 이메일을 알고 있는지"로 본인 확인을 대신하는 방식이다.
function verifyRecoveryEmail(djId, email) {
  const djs = loadDjs();
  const rec = djs[djId];
  if (!rec) return { ok: false, error: '존재하지 않는 아이디예요' };
  if (!rec.email) return { ok: false, error: '이 계정은 비밀번호 찾기용 이메일이 등록되어 있지 않아요. 관리자에게 문의해주세요.' };
  const input = String(email || '').trim().toLowerCase();
  if (!input || input !== rec.email) return { ok: false, error: '이메일이 일치하지 않아요' };
  return { ok: true };
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
    lastLoginAt: djs[id].lastLoginAt || null,
    signupIp: djs[id].signupIp || null,
    autoJoinTag: djs[id].settings?.autoJoinTag || '',
    blocked: !!djs[id].blocked,
    autoJoinEnabled: !!djs[id].autoJoinEnabled,
    expiresAt: djs[id].settings?.expiresAt || null,
    referrerId: djs[id].referrerId || null,
  }));
}

// 마지막 접속일 기준 7일 이상 미접속 계정의 다중감시(자동입장) 고유닉 목록을 자동으로 비운다.
// 관리자(sum)는 대상에서 제외. 매일 한 번(cleanupInactiveAutoJoin 호출부에서) 실행된다.
// autoJoinWatch도 함께 꺼서, 그 계정이 다시 로그인하기 전까지는 자동입장 감시 대상에서 완전히 빠지게 한다.
// ⚠️ lastLoginAt은 이번에 새로 추가된 필드라 기존 계정엔 값이 없을 수 있다(실제로는 계속 활동 중일 수 있음).
// 그래서 lastLoginAt이 아예 없는 계정은 건드리지 않고, 로그인 기록이 실제로 쌓인 뒤 7일 이상
// 지난 경우에만 정리한다 — 배포 직후 멀쩡한 계정이 잘못 정리되는 걸 막기 위함.
function cleanupInactiveAutoJoinTags(inactiveDays = 7) {
  const djs = loadDjs();
  const cutoff = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;
  const affected = [];
  for (const id of Object.keys(djs)) {
    if (id === 'sum') continue;
    const rec = djs[id];
    if (!rec.lastLoginAt) continue; // 로그인 기록이 아직 없으면(=신규 필드라 값 없음) 건드리지 않음
    if (rec.lastLoginAt >= cutoff) continue; // 최근 7일 안에 접속했으면 건너뜀
    const s = rec.settings;
    if (!s) continue;
    const hadTags = (Array.isArray(s.autoJoinTags) && s.autoJoinTags.length) || !!s.autoJoinTag;
    if (!hadTags && s.autoJoinWatch !== true) continue; // 이미 비어있으면 손댈 필요 없음
    s.autoJoinTags = [];
    s.autoJoinTag = '';
    s.autoJoinWatch = false;
    affected.push(id);
  }
  if (affected.length) saveDjs(djs);
  return affected;
}

function setAutoJoinEnabled(djId, enabled) {
  const djs = loadDjs();
  if (!djs[djId]) return false;
  djs[djId].autoJoinEnabled = !!enabled;
  saveDjs(djs);
  return true;
}

// 관리자 전용 — 특정 유저의 "고유닉 2일 변경 잠금"을 즉시 풀어준다 (오탈자 정정, 정당한 사유 등 예외 상황용).
function resetAutoJoinTagLock(djId) {
  const djs = loadDjs();
  if (!djs[djId] || !djs[djId].settings) return { ok: false, error: '유저를 찾을 수 없어요' };
  djs[djId].settings.autoJoinLockedTags = [];
  djs[djId].settings.autoJoinTagLockedAt = null;
  saveDjs(djs);
  return { ok: true };
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
  cleanupInactiveAutoJoinTags,
  setBlocked,
  deleteDj,
  resetSettings,
  isBlocked,
  setAutoJoinEnabled,
  resetAutoJoinTagLock,
  getAutoJoinEnabled,
  exists,
  verifyPassword,
  changePassword,
  renameDjId,
  getDefaultTrialDays,
  setDefaultTrialDays,
  getRequestModules,
  saveRequestModules,
  findDuplicateSignup,
  getDuplicateCheckAllowedIps,
  addDuplicateCheckAllowedIp,
  removeDuplicateCheckAllowedIp,
  getAnnouncement,
  setAnnouncement,
  getAnnouncementHistory,
  getStatusBanner,
  setStatusBanner,
  getAdminStats,
  validEmail,
  DATA_DIR,
  verifyRecoveryEmail,
  flush,
  createBackupSnapshot,
};
