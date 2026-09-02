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
//
// 🐌 사고 기록(2026-08, 추가): saveSettings()가 호출될 때마다 saveDjs()를 통해 djs.json
// "전체"를 매번 동기(fs.writeFileSync)로 다시 썼다. 채팅 명령어(잡기/분해/입장/보스참여 등)
// 코드 곳곳에서 이 saveSettings()를 아주 자주 호출하다보니, 동시접속자가 늘어날수록(예: 10명
// 정도가 동시에 명령어를 쓰면) 이 동기 쓰기가 겹겹이 쌓여 이벤트 루프가 막히고, 그 사이
// 다른 사람 명령어 응답이 느려지거나 방 입장 처리가 타이밍을 놓쳐 실패하는 문제가 있었다.
// 그래서 saveSettings()는 이제 메모리 캐시만 "즉시" 갱신하고(그래서 읽기는 항상 최신 상태),
// 실제 디스크 반영은 scheduleFlush()로 짧게(1초) 묶어서 마지막 한 번만 하도록 바꿨다.
// 데이터 유실 걱정 때문에 무한정 늦추지는 않고, 그 사이 다시 호출되면 타이머만 리셋되는 게
// 아니라 "최대 지연" 상한(maxDelayMs)도 같이 둬서, 계속 저장 요청이 들어와도 일정 시간
// 안에는 반드시 한 번은 디스크에 반영되게 한다. 서버 종료 신호(SIGTERM/SIGINT)에도
// flush()를 걸어서, 재배포로 인한 정상 종료 시에는 유실 없이 마지막 상태까지 저장된다.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DJ_FILE = path.join(DATA_DIR, 'djs.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP_COUNT = 20; // 최근 20개까지만 보관 (그 이상 오래된 건 자동 삭제)
const GLOBAL_MC_FILE = path.join(DATA_DIR, 'globalMonsterDex.json'); // 🌐 몬스터 잡기 유저 데이터(포획볼/도감/채팅카운트) — 디제이 구분 없이 전체 플랫폼 공용

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
// ⚠️ 이 함수 자체는 여전히 동기(blocking)다 — 그래서 saveSettings()에서 매번 바로 부르지
// 않고, scheduleFlush()로 짧게 묶어서 뜸하게만 호출하도록 바꿨다 (아래 참고).
function saveDjs(djs) {
  ensureDir();
  _cache = djs; // 캐시 갱신
  const json = JSON.stringify(djs, null, 2);
  const tmpFile = DJ_FILE + '.tmp';
  fs.writeFileSync(tmpFile, json, 'utf-8');
  fs.renameSync(tmpFile, DJ_FILE);
}

// 🗂️ 주기적 백업 — 타임스탬프 붙여서 backups/ 폴더에 스냅샷을 남긴다.
// djs.json뿐 아니라 globalMonsterDex.json(몬스터 잡기 전역 유저 데이터)도 같은 방식으로
// 같이 백업한다 — 전부 Railway Volume(DATA_DIR) 안에서만 처리되고 외부 서비스는 안 쓴다.
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
    if (_globalMcCache) {
      const mcBackupFile = path.join(BACKUP_DIR, `globalMonsterDex-${stamp}.json`)
      fs.writeFileSync(mcBackupFile, JSON.stringify(_globalMcCache, null, 2), 'utf-8')
      const mcFiles = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('globalMonsterDex-')).sort()
      while (mcFiles.length > BACKUP_KEEP_COUNT) {
        const oldest = mcFiles.shift()
        try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)) } catch (e) {}
      }
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
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_flushMaxTimer) { clearTimeout(_flushMaxTimer); _flushMaxTimer = null; }
  _flushScheduledAt = 0;
  if (_cache) saveDjs(_cache);
}

// 🐌 saveSettings()가 호출될 때마다 곧바로 saveDjs()(=디스크 전체 재작성)를 부르지 않고,
// 짧게(디바운스) 묶어서 마지막 한 번만 실제로 디스크에 반영한다.
// - 1초 안에 또 호출되면 타이머를 뒤로 미룬다 (연속 호출 중엔 계속 미뤄짐)
// - 다만 계속 저장 요청이 들어와서 무한정 미뤄지는 걸 막기 위해, 최초 예약 시점부터
//   최대 3초가 지나면 그 사이 또 예약이 걸려있어도 강제로 한 번은 flush한다.
// - 캐시(_cache)는 saveSettings()에서 이미 즉시 갱신되므로, 이 사이 다른 요청이 읽어가는
//   값은 항상 최신이다 — 디스크 반영만 늦춰질 뿐 메모리상 데이터는 지연이 없다.
let _flushTimer = null;
let _flushMaxTimer = null;
let _flushScheduledAt = 0;
const FLUSH_DEBOUNCE_MS = 1000;
const FLUSH_MAX_DELAY_MS = 3000;
function scheduleFlush() {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
  if (!_flushScheduledAt) {
    _flushScheduledAt = Date.now();
    _flushMaxTimer = setTimeout(flush, FLUSH_MAX_DELAY_MS);
  }
}

function defaultSettings() {
  return {
    autoJoinTag: '',
    preferredTokenDjId: '', // 🎯 본인 세션이 없을 때 쓸 공용 계정(sum/sum2/sum3...)을 직접 고른 값. 비어있으면 자동 배정.
    autoJoinTags: [], // 다중 감시용 (여러 고유닉)
    autoJoinWatch: false,
    botEnabled: true, // 꺼두면 이 계정은 어떤 봇 명령어/자동멘트에도 반응하지 않는 순수 시청 모드가 된다
    // 🎓 처음 오신 분 튜토리얼을 자동으로 띄웠는지 여부. true(기본값)면 자동으로는 안 띄운다 —
    // signup() 안에서 신규가입 계정에 한해 false로 덮어써서, 그 계정만 최초 로그인 때 한 번 자동으로 뜨게 한다.
    // (기존에 이미 가입된 계정들은 이 필드 자체가 없는 상태로 저장돼있는데, 그런 경우도 "이미 봤다"와
    // 똑같이 취급해서 갑자기 튜토리얼이 뜨지 않게 한다 — 관련 로직은 /tutorial/status 참고)
    tutorialShown: true,
    // 사이드바 각 메뉴별 ON/OFF. false로 꺼두면 그 메뉴 화면이 잠기고,
    // 채팅 명령어 처리 로직으로 이어지는 항목(실드/깃발/펀딩/단축키/지정인사/신청곡/
    // 룰렛/애청지수/퀴즈/입장설정/자동입장/채팅)은 실제로도 응답하지 않게 된다.
    moduleEnabled: {
      session: true, userlist: true, autojoin: true, chat: true,
      entrysettings: true, funding: true, shortcuts: true, greet: true,
      flag: true, shield: true, request: true, roulette: true,
      roulettelog: true, autogrant: true, loyalty: true, quiz: true, botreboot: true,
      migrate: true, lottoauto: false, reactiontimer: false, dday: false, raffle: false, dice: false, soundfx: false, tts: false, dashboard: false, wheelroulette: false, couponcheck: false, usernotes: false, discordnotify: false, fishing: false, blinddate: false, // ※ 새로 추가되는 모듈은 기본 OFF — 유저가 모듈 마켓에서 직접 찾아 켜야 함
    },
    // 사이드바 각 메뉴를 "화면에 표시할지"만 따로 관리한다. moduleEnabled(기능 자체 켜짐/꺼짐)와는 별개라서,
    // 기능은 계속 켜둔 채로(자동 명령어 등은 그대로 동작) 사이드바만 정리해서 안 보이게 할 수 있다.
    moduleVisible: {
      session: true, userlist: true, autojoin: true, chat: true,
      entrysettings: true, funding: true, shortcuts: true, greet: true,
      flag: true, shield: true, request: true, roulette: true,
      roulettelog: true, autogrant: true, loyalty: true, quiz: true, botreboot: true,
      migrate: true, lottoauto: true, reactiontimer: true, dday: true, raffle: true, dice: true, soundfx: true, tts: true, dashboard: true, wheelroulette: true, couponcheck: true, usernotes: true, discordnotify: true, fishing: true, blinddate: true,
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
      items: [], // { id, artist, title, requester, matchedTitle?, ytCandidates? }
      verifyOriginalOnRequest: false, // 🎬 켜두면 접수 즉시 유튜브에서 검색해 "원곡"이 있는지 확인하고,
      // MR/반주/노래방 버전만 나오거나 아예 없으면 그 신청을 거절한다 (기본값은 꺼짐 — 기존처럼 그냥 접수).
    },
    roulette: {
      list: [], // { id, name, triggerMode: 'exact'|'combo'|'distribute', triggerAmount, items: [{id, name, percent, skipHistory}] }
      resultHeaderTemplate: '[🎡{룰렛명}] {닉네임}님 당첨! 🎉',
      couponUseTemplate: '🎡 {닉네임}님이 룰렛{번호} 권 {수량}개를 사용했습니다! (잔여: {잔여}개)',
      couponLowTemplate: '🎡 {닉네임}님, 룰렛{번호}({룰렛명}) 권이 부족합니다.',
      menuPageSize: 10, // !룰렛메뉴N 명령어로 항목 목록을 볼 때 한 번에 몇 개씩 끊어서 보여줄지
      keepPageSize: 10, // !킵/!이벤트/!내카드(기타목록) 목록을 볼 때 한 번에 몇 개씩 끊어서 보여줄지
    },
    rouletteHistory: {}, // { [tag]: { coupons: {}, wins: [], keepList: {name:count}, miscList: {}, eventList: {} } }
    // 📋 포스트 — DJ가 만든 이벤트/공지 게시물. 내정보 웹페이지 "포스트" 탭에서 스푼 앱 게시물처럼
    // 보여준다. { id, title, imageUrl, dateStart, dateEnd, createdAt, likes:[tag,...], comments:[{id,tag,nickname,text,createdAt}] }
    posts: [],
    // 📅 캘린더 — DJ가 등록한 행사/방송 일정. 내정보 웹페이지 "캘린더" 탭에 달력 형태로 보여준다.
    // { id, date:'YYYY-MM-DD', time:'HH:MM'(선택), title, description, createdAt }
    calendarEvents: [],
    // 🖼️ 직접 디자인한 캘린더 이미지(포스터형). 등록해두면 캘린더 탭 위쪽에 같이 보여주고,
    // hideGrid를 켜면 자동 달력 그리드는 숨기고 이 이미지만 보여준다.
    // 🖼️ 직접 디자인한 캘린더 이미지(포스터형). 등록해두면 캘린더 탭 위쪽에 같이 보여주고,
    // hideGrid를 켜면 자동 달력 그리드는 숨기고 이 이미지만 보여준다.
    // overlay를 켜면 이미지 안의 "달력 표" 영역(퍼센트 좌표)에 실제 클릭 가능한 투명 칸을 겹쳐서,
    // 이미지에 그려진 날짜를 클릭하면 그 날짜의 일정이 뜨게 만들 수 있다 (year/month는 이 이미지가
    // 어느 달을 나타내는지, top/left/width/height는 이미지 안에서 달력 표가 차지하는 영역 %).
    calendarImage: { url: '', hideGrid: false, overlay: { enabled: false, year: null, month: null, top: 0, left: 0, width: 100, height: 100 } },
    // 💘 소개팅 매니저 — 커플/강전 후보 목록과 비토·비마 스푼 지갑을 DJ별로 관리
    blindDate: {
      cmdCouple: '!커플',       // 목록/추가/삭제/초기화/전체초기화 서브명령의 기준 단어
      cmdStrong: '!강전',       // 목록/삭제/초기화 + "!강전 @태그 [증감]" 스택 조절
      cmdWalletView: '!지갑',   // 조회 · "!지갑 초기화"
      cmdWalletAdd: '!비토',    // 스푼 추가
      cmdWalletSub: '!비마',    // 스푼 차감
      pageSize: 10,
      couples: [], // { id, tagA, nickA, tagB, nickB, forced, createdAt }
      strongCandidates: [], // { id, tag, nickname, stack, updatedAt }
      wallet: { balance: 0, updatedAt: null },
    },
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

// 마지막 접속(로그인)이 이 일수 이상 지난 계정은 다중감시(자동입장) 등록 태그를 자동으로 비운다.
// 관리자(sum) 계정의 settings.autoJoinCleanupDays에 저장해서 관리한다.
// 값이 없으면(처음 세팅 전) 기존 하드코딩값과 동일한 기본 4일을 쓴다. 0으로 설정하면 자동정리 자체를 끈다.
function getAutoJoinCleanupDays() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.autoJoinCleanupDays;
  return (typeof v === 'number' && v >= 0) ? v : 4;
}

function setAutoJoinCleanupDays(days) {
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: '0 이상의 숫자를 입력해주세요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  djs['sum'].settings.autoJoinCleanupDays = n;
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
//
// 전체 스위치도 따로 둔다 — 데이터 유실 복구처럼 짧은 시간에 여러 명이 재가입해야 하는
// 상황에서는 이 체크 자체가 방해가 될 수 있어서, 관리자가 통째로 껐다 켰다 할 수 있게 한다.
function getDuplicateCheckEnabled() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.duplicateCheckEnabled;
  return v !== false; // 기본값 true (명시적으로 false로 꺼둔 경우만 꺼짐)
}
function setDuplicateCheckEnabled(enabled) {
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  djs['sum'].settings.duplicateCheckEnabled = !!enabled;
  saveDjs(djs);
  return { ok: true };
}

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
// ⚠️ 아래 "이미지 팝업"이랑은 완전히 독립된 별개 기능이다 — 텍스트 공지엔 이미지 필드가 없다.
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

// 🖼️ 이미지 팝업 — 위 "업데이트 공지"(텍스트)랑 완전히 독립된 별개 기능. 로그인할 때 이 이미지 팝업이
// 먼저 뜨고, 그 다음에 업데이트 공지(텍스트) 팝업이 뜬다. 각자 등록/이력/확인여부를 따로 관리한다.
function getImagePopup() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.imagePopup;
  return v && v.id ? v : null;
}
function getImagePopupHistory() {
  const djs = loadDjs();
  const v = djs['sum'] && djs['sum'].settings && djs['sum'].settings.imagePopupHistory;
  return Array.isArray(v) ? v : [];
}
function setImagePopup(imageUrl) {
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  const url = String(imageUrl || '').trim();
  if (!url) return { ok: false, error: '이미지를 먼저 업로드해주세요' };
  const popup = { id: Date.now(), imageUrl: url, createdAt: Date.now() };
  djs['sum'].settings.imagePopup = popup;
  const history = Array.isArray(djs['sum'].settings.imagePopupHistory) ? djs['sum'].settings.imagePopupHistory : [];
  history.unshift(popup) // 최신이 맨 앞
  djs['sum'].settings.imagePopupHistory = history.slice(0, 50) // 최근 50개까지만 보관
  saveDjs(djs);
  return { ok: true, popup };
}
// 지금 활성화된 이미지 팝업을 끈다 (더 이상 로그인할 때 안 뜸). 지난 이력(imagePopupHistory)은 그대로 남는다.
function clearImagePopup() {
  const djs = loadDjs();
  if (!djs['sum'] || !djs['sum'].settings) return { ok: false, error: '관리자 계정이 아직 없어요' };
  djs['sum'].settings.imagePopup = null;
  saveDjs(djs);
  return { ok: true };
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

// 🔑 세션 연결 전역 강제 OFF — 관리자(sum)가 끄면, 일반 디제이는 각자 계정의 개인 모듈 설정과
// 상관없이 사이드바에서 "세션 연결" 메뉴 자체가 안 보이게 된다. (관리자 본인은 항상 그대로 보임)
// 상태 배너와 동일한 방식으로 관리자(sum) 계정의 settings에 중앙 저장한다.
function getSessionModuleGlobalOff() {
  const djs = loadDjs();
  return !!(djs['sum'] && djs['sum'].settings && djs['sum'].settings.sessionModuleGlobalOff);
}
function setSessionModuleGlobalOff(off) {
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  djs['sum'].settings.sessionModuleGlobalOff = !!off;
  saveDjs(djs);
  return { ok: true, off: djs['sum'].settings.sessionModuleGlobalOff };
}

// 🎬 유튜브 Data API v3 키 — 관리자(sum)가 관리자 페이지에서 최대 3개까지 등록할 수 있다.
// 하나가 일일 쿼터를 다 쓰면(quotaExceeded) 자동으로 다음 등록 키로 넘어가서 검색을 계속한다.
// 관리자가 따로 등록해두지 않았으면 기존처럼 Railway 환경변수(YOUTUBE_API_KEY(S))를 그대로 쓴다.
const YOUTUBE_API_KEY_MAX = 3
function getYoutubeApiKeys() {
  const djs = loadDjs();
  const arr = djs['sum'] && djs['sum'].settings && djs['sum'].settings.youtubeApiKeys;
  if (Array.isArray(arr) && arr.length) {
    return arr.map(k => String(k || '').trim()).filter(Boolean);
  }
  // 예전 버전(키 1개만 저장하던 시절)과의 호환 — 있으면 배열 하나로 취급해서 그대로 써준다.
  const legacy = djs['sum'] && djs['sum'].settings && djs['sum'].settings.youtubeApiKey;
  if (typeof legacy === 'string' && legacy.trim()) return [legacy.trim()];
  return [];
}
function setYoutubeApiKeys(keys) {
  const djs = loadDjs();
  if (!djs['sum']) return { ok: false, error: '관리자 계정이 아직 없어요' };
  if (!djs['sum'].settings) djs['sum'].settings = defaultSettings();
  const cleaned = (Array.isArray(keys) ? keys : [])
    .map(k => String(k || '').trim())
    .filter(Boolean)
    .slice(0, YOUTUBE_API_KEY_MAX);
  djs['sum'].settings.youtubeApiKeys = cleaned;
  delete djs['sum'].settings.youtubeApiKey; // 새 배열 필드로 완전히 이전
  saveDjs(djs);
  return { ok: true, count: cleaned.length };
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

  if (!skipDupCheck && getDuplicateCheckEnabled()) {
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
  // 🎓 신규 가입 계정만 최초 로그인 때 튜토리얼이 자동으로 뜨게 false로 시작한다 (기본값은 true=이미 봄).
  settings.tutorialShown = false;
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

// 🐌 채팅 명령어(잡기/분해/입장/보스참여 등) 곳곳에서 아주 자주 호출된다. 예전엔 호출될
// 때마다 djs.json 전체를 동기로 다시 썼는데, 여기서는 캐시만 "즉시" 갱신하고 실제 디스크
// 반영은 scheduleFlush()로 짧게 묶어서 처리한다 — 동시접속자가 많아져도 저장 자체가
// 병목이 되지 않는다. 읽기(getSettings)는 캐시를 그대로 보므로 지연 없이 항상 최신이다.
function saveSettings(djId, patch) {
  const djs = loadDjs();
  if (!djs[djId]) return false;
  djs[djId].settings = { ...djs[djId].settings, ...patch };
  scheduleFlush();
  return true;
}

function listDjIds() {
  return Object.keys(loadDjs());
}

// 🌐 몬스터 잡기 — 유저(고유닉) 기준 포획볼/고급볼/도감/채팅카운트를 디제이 구분 없이 전체
// 플랫폼 공용으로 관리한다. A디제이 방에서 모험을 시작하고 몬스터를 모았으면, B디제이 방에
// 가서도 그대로 이어서 쓸 수 있게 하기 위함. djs.json과 별도 파일에 저장하고, djId별 settings와는
// 완전히 분리해서 관리한다 (그래야 디제이 수·유저 수가 늘어도 각 디제이 설정 파일이 비대해지지 않음).
let _globalMcCache = null;

function loadGlobalMonsterDex() {
  if (_globalMcCache) return _globalMcCache;
  ensureDir();
  if (fs.existsSync(GLOBAL_MC_FILE)) {
    try {
      const raw = fs.readFileSync(GLOBAL_MC_FILE, 'utf-8');
      if (raw && raw.trim()) _globalMcCache = JSON.parse(raw);
    } catch (e) {
      console.log('[store] globalMonsterDex.json 읽기 실패:', e.message);
    }
  }
  if (!_globalMcCache) {
    // 최초 1회 — 예전에 디제이별 settings.monsterCatch 안에 따로따로 흩어져 있던 유저 데이터를
    // 전부 합쳐서 하나의 전역 저장소로 옮긴다. 포획볼/고급볼/도감 보유수는 합산(SUM), 채팅
        // 카운트는 최대값(MAX)으로 합쳐서, 이미 모아둔 걸 잃어버리지 않게 한다. 파일이 한 번
    // 만들어진 뒤로는 이 마이그레이션이 다시 실행되지 않는다.
    const merged = { bags: {}, greatBags: {}, collections: {}, chatCounts: {}, catalog: {} };
    try {
      const djs = loadDjs();
      Object.values(djs).forEach(dj => {
        const mc = dj && dj.settings && dj.settings.monsterCatch;
        if (!mc) return;
        Object.entries(mc.bags || {}).forEach(([k, v]) => { merged.bags[k] = (merged.bags[k] || 0) + (Number(v) || 0); });
        Object.entries(mc.greatBags || {}).forEach(([k, v]) => { merged.greatBags[k] = (merged.greatBags[k] || 0) + (Number(v) || 0); });
        Object.entries(mc.chatCounts || {}).forEach(([k, v]) => { merged.chatCounts[k] = Math.max(merged.chatCounts[k] || 0, Number(v) || 0); });
        Object.entries(mc.collections || {}).forEach(([k, owned]) => {
          if (!merged.collections[k]) merged.collections[k] = {};
          Object.entries(owned || {}).forEach(([monId, cnt]) => {
            merged.collections[k][monId] = (merged.collections[k][monId] || 0) + (Number(cnt) || 0);
          });
        });
        // 🐾 이름/이미지 도감(카탈로그)도 디제이들이 그동안 등록해둔 몬스터 목록에서 합쳐온다 —
        // 그래야 다른 디제이 방에 가서 !도감을 쳐도 그 몬스터 이름이 뜬다 (그 방에 등록 안 돼있어도).
        (mc.monsters || []).forEach(m => {
          if (m && m.id && m.name) merged.catalog[m.id] = { name: m.name, image: m.image || '', legendary: !!m.legendary };
        });
      });
      if (Object.keys(merged.bags).length) console.log(`[store] 🌐 몬스터 잡기 유저 데이터 ${Object.keys(merged.bags).length}명분을 전역 저장소로 1회 마이그레이션했어요.`);
    } catch (e) {
      console.log('[store] 몬스터 잡기 마이그레이션 중 오류:', e.message);
    }
    _globalMcCache = merged;
    saveGlobalMonsterDex();
  }
  if (!_globalMcCache.bags) _globalMcCache.bags = {};
  if (!_globalMcCache.greatBags) _globalMcCache.greatBags = {};
  if (!_globalMcCache.collections) _globalMcCache.collections = {};
  if (!_globalMcCache.chatCounts) _globalMcCache.chatCounts = {};
  if (!_globalMcCache.catalog) {
    // 이미 예전 버전으로 globalMonsterDex.json이 만들어져 있던 서버라면 위 마이그레이션 블록을
    // 안 타고 여기로 오는데, 그 경우에도 카탈로그(몬스터 이름/이미지)만큼은 지금 등록돼 있는
    // 디제이들 목록에서 즉시 한 번 채워준다 — 그래야 다들 다시 저장 누를 필요 없이 바로 반영됨.
    _globalMcCache.catalog = {};
    try {
      const djs = loadDjs();
      Object.values(djs).forEach(dj => {
        const mc = dj && dj.settings && dj.settings.monsterCatch;
        (mc && mc.monsters || []).forEach(m => {
          if (m && m.id && m.name) _globalMcCache.catalog[m.id] = { name: m.name, image: m.image || '', legendary: !!m.legendary };
        });
      });
      if (Object.keys(_globalMcCache.catalog).length) {
        console.log(`[store] 🐾 몬스터 카탈로그 ${Object.keys(_globalMcCache.catalog).length}종을 기존 디제이 목록에서 즉시 채워넣었어요.`);
        saveGlobalMonsterDex();
      }
    } catch (e) {
      console.log('[store] 몬스터 카탈로그 백필 중 오류:', e.message);
    }
  }
  return _globalMcCache;
}

// 디제이가 몬스터 목록을 저장할 때마다 호출 — 그 몬스터들의 id/이름/이미지를 전역 카탈로그에
// 업서트한다. 다른 디제이 방에서 !도감 쳤을 때 이름을 찾는 용도(이 디제이가 "정답" 소스는 아니고,
// 그냥 마지막으로 저장한 값으로 갱신됨 — 같은 id를 여러 디제이가 다르게 쓰면 마지막 저장이 이김).
function upsertMonsterCatalog(monsters) {
  const dex = loadGlobalMonsterDex();
  let changed = false;
  (monsters || []).forEach(m => {
    if (!m || !m.id || !m.name) return;
    const next = { name: m.name, image: m.image || '', legendary: !!m.legendary };
    const prev = dex.catalog[m.id];
    // ⚡ 실제로 값이 달라질 때만 changed=true로 표시한다. 매번 무조건 changed 처리하면
    // (예전 방식) 설정을 "불러올 때마다" 이 함수를 호출해서 자동 동기화하는 용도로 쓸 때
    // 매 호출마다 디스크에 파일을 새로 써버려서(fs.writeFileSync+rename) 매우 비효율적이다.
    if (!prev || prev.name !== next.name || prev.image !== next.image || prev.legendary !== next.legendary) {
      dex.catalog[m.id] = next;
      changed = true;
    }
  });
  if (changed) saveGlobalMonsterDex();
}

// 원자적 저장 — djs.json과 동일한 tmp파일 후 rename 방식.
function saveGlobalMonsterDex() {
  if (!_globalMcCache) return;
  ensureDir();
  const json = JSON.stringify(_globalMcCache, null, 2);
  const tmpFile = GLOBAL_MC_FILE + '.tmp';
  fs.writeFileSync(tmpFile, json, 'utf-8');
  fs.renameSync(tmpFile, GLOBAL_MC_FILE);
}

// 🌐 외부 백업(Base44)용 — 전체 계정 데이터를 그대로 반환한다 (비밀번호 해시 포함, 백업 목적이라 그대로 둠).
function getRawSnapshot() {
  return loadDjs();
}
// 특정 DJ 한 명의 전체 레코드(비밀번호 해시 포함)를 가져온다 — 본인 셀프 백업용.
function getDjRecord(djId) {
  const djs = loadDjs();
  return djs[djId] || null;
}

// 🔄 외부 백업에서 가져온 특정 DJ 레코드를 그대로 덮어써서 복구한다.
function restoreDjRecord(djId, record) {
  const djs = loadDjs();
  djs[djId] = record;
  saveDjs(djs);
}

// 🔄 R2 전체 백업에서 가져온 djs 스냅샷으로 "통째로" 덮어쓴다 (개별 계정 병합이 아니라 전체 교체).
// mergeDjBackupSubset과 달리 되돌릴 수 없는 파괴적인 작업이라, 호출하는 쪽(index.js)에서
// confirm 절차를 반드시 거치게 한다.
function restoreFullDjsSnapshot(djsData) {
  if (!djsData || typeof djsData !== 'object') return { ok: false, error: '올바른 백업 데이터가 아니에요' };
  saveDjs(djsData);
  return { ok: true, accountCount: Object.keys(djsData).length };
}

// 🔄 R2 전체 백업에서 가져온 globalMonsterDex 스냅샷으로 통째로 덮어쓴다.
function restoreGlobalMonsterDexSnapshot(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: '올바른 백업 데이터가 아니에요' };
  _globalMcCache = data;
  saveGlobalMonsterDex();
  return { ok: true };
}

// 🔄 축소된 백업(룰렛/룰렛기록/애청지수/반복문구/단축명령어)만 기존 계정 설정에 "병합"해서 복구한다.
// 계정 정보(비밀번호 등)나 그 외 다른 모듈 설정은 그대로 두고, 이 5개 항목만 덮어쓴다.
function mergeDjBackupSubset(djId, subset) {
  const djs = loadDjs();
  if (!djs[djId]) return { ok: false, error: '계정을 찾을 수 없어요' };
  if (!djs[djId].settings) djs[djId].settings = {};
  const s = djs[djId].settings;
  if (subset.roulette != null) s.roulette = subset.roulette;
  if (subset.rouletteHistory != null) s.rouletteHistory = subset.rouletteHistory;
  if (subset.activity != null) s.activity = subset.activity;
  if (subset.commands != null) s.commands = subset.commands;
  if (Array.isArray(subset.entryDataRepeat)) {
    if (!s.entryData) s.entryData = {};
    s.entryData.repeat = subset.entryDataRepeat;
  }
  saveDjs(djs);
  return { ok: true };
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
  if (!inactiveDays || inactiveDays <= 0) return []; // 0 이하로 설정되면 자동정리 자체를 끈다
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
  getAutoJoinCleanupDays,
  setAutoJoinCleanupDays,
  getRequestModules,
  saveRequestModules,
  findDuplicateSignup,
  getDuplicateCheckAllowedIps,
  addDuplicateCheckAllowedIp,
  removeDuplicateCheckAllowedIp,
  getDuplicateCheckEnabled,
  setDuplicateCheckEnabled,
  getAnnouncement,
  setAnnouncement,
  getAnnouncementHistory,
  getImagePopup,
  setImagePopup,
  clearImagePopup,
  getImagePopupHistory,
  getStatusBanner,
  setStatusBanner,
  getSessionModuleGlobalOff,
  setSessionModuleGlobalOff,
  getYoutubeApiKeys,
  setYoutubeApiKeys,
  getAdminStats,
  validEmail,
  DATA_DIR,
  verifyRecoveryEmail,
  flush,
  createBackupSnapshot,
  getRawSnapshot,
  getDjRecord,
  restoreDjRecord,
  mergeDjBackupSubset,
  restoreFullDjsSnapshot,
  restoreGlobalMonsterDexSnapshot,
  loadGlobalMonsterDex,
  saveGlobalMonsterDex,
  upsertMonsterCatalog,
};
