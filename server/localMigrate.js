// ══════════════════════════════════════════════════════════════
// 로컬 에디봇(Electron) 데이터 → 웹 에디봇(store.js) 설정 변환 로직 (공용 모듈)
//
// store.js 저장은 하지 않는다 — 순수하게 "로컬 원본 데이터 -> settings patch 객체 + 리포트"로만
// 변환하고, 실제 저장(store.saveSettings)은 호출하는 쪽(CLI 스크립트 / 웹 API 라우트)에서 각자 한다.
// 이렇게 분리해두면 CLI(관리자용)와 웹 화면(본인 계정 셀프서비스)이 같은 변환 로직을 공유할 수 있다.
//
// 옮기지 못하는 것: 검 강화(sword) 가챠, 낚시대회, 효과음/TTS, 애교봇/AI질문봇/메모/주사위 —
//   웹봇에 아직 없는 기능이라 스킵. 지정 인사의 mp3 오디오도 텍스트만 옮기고 버린다.
// 확인이 필요한 것: 룰렛 기록의 "룰렛권" 인덱스는 로컬 데이터에 구멍이 있을 수 있어(과거 룰렛 삭제 이력)
//   현재 룰렛 목록 순서에 그대로 위치 매핑한다. 완전히 정확하지 않을 수 있다.
// ══════════════════════════════════════════════════════════════

function buildMigrationPatch(raw) {
  raw = raw || {};

  // localStorage 값들은 대부분 "JSON 문자열"로 한 번 더 감싸져 저장되어 있어서 한 번 더 파싱한다.
  function j(key, fallback) {
    const v = raw[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  }
  function pick(v, fallback) {
    return (v === undefined || v === null || v === '') ? fallback : v;
  }

  const report = [];
  const patch = {};
  let seq = 0;
  const uid = () => `${Date.now()}_${seq++}`;

  // ── 1) 실드 ──────────────────────────────────────────────
  try {
    const shieldCount = Number(raw.spoon_shield_count) || 0;
    const o = j('spoon_shield_options', {});
    patch.shield = {
      count: shieldCount,
      resetCount: 0,
      cmd: o.customCmd || '!실드',
      msgView: o.format || '🛡️ 현재 보유 중인 실드는 {실드}개 입니다!',
      msgAdd: o.updateFormat || '✅ 실드 {amount}개 적립 완료!\n현재 실드: {실드}개',
      msgSub: o.updateFormat || '▼ 실드 {amount}개 차감 완료!\n현재 실드: {실드}개',
      perms: Array.isArray(o.authList) ? o.authList : [],
      strictPerms: false,
    };
    report.push(`✅ 실드: ${shieldCount.toLocaleString()}개, 권한자 ${patch.shield.perms.length}명`);
  } catch (e) { report.push(`⚠️ 실드 마이그레이션 실패: ${e.message}`); }

  // ── 2) 단축키 명령어 ─────────────────────────────────────
  try {
    const cmds = j('spoon_cmds', []);
    patch.commands = cmds.map(c => ({
      id: 'cmd' + uid(),
      trigger: c.trigger,
      response: c.response,
      scope: 'all',
      cooldown: Number(c.cooldown) || 0,
      useCount: 0,
    }));
    report.push(`✅ 단축키 명령어 ${patch.commands.length}개`);
  } catch (e) { report.push(`⚠️ 단축키 마이그레이션 실패: ${e.message}`); }

  // ── 3) 지정 인사 (텍스트만, 오디오 제외) ─────────────────
  try {
    const joinmsgs = j('spoon_joinmsgs', []);
    patch.greetings = joinmsgs.map(g => ({
      id: 'gr' + uid(),
      tag: g.tag,
      message: g.response,
    }));
    const audioCount = joinmsgs.filter(g => g.audioData).length;
    report.push(`✅ 지정 인사 ${patch.greetings.length}명 (오디오 첨부 ${audioCount}건은 텍스트만 이전)`);
  } catch (e) { report.push(`⚠️ 지정 인사 마이그레이션 실패: ${e.message}`); }

  // ── 4) 신청곡 ────────────────────────────────────────────
  try {
    const s = j('spoon_song_settings', {});
    const songs = j('spoon_songs', []);
    patch.songRequest = {
      accepting: s.enabled !== false,
      priorityMode: !!s.priority,
      showRequester: s.showNicknames !== false,
      cmdRequest: s.customCmd || '!신청곡',
      cmdRemove: s.delCmd || '!제거',
      cmdReset: s.resetCmd || '리셋',
      cmdClose: s.stopCmd || '!마감',
      cmdOpen: s.startCmd || '!접수',
      cmdPriorityOn: s.priorityOnCmd || '!우선온',
      cmdPriorityOff: s.priorityOffCmd || '!우선오프',
      cmdNameOn: s.nameOnCmd || '!이름온',
      cmdNameOff: s.nameOffCmd || '!이름오프',
      doneTemplate: s.regFormat || '✅ [{artist} - {title}] 신청 완료! (대기: {count}번)',
      listTitle: s.listHeader || '🎵 현재 신청곡 목록 🎵',
      listItemTemplate: s.listFormat || '{index}. {artist} - {title}',
      maxCharsPerMsg: 100,
      msgIntervalMs: 600,
      items: songs.map(it => ({ id: 'sr' + uid(), artist: it.artist, title: it.title, requester: it.user || '' })),
    };
    report.push(`✅ 신청곡 설정 + 대기열 ${patch.songRequest.items.length}곡`);
  } catch (e) { report.push(`⚠️ 신청곡 마이그레이션 실패: ${e.message}`); }

  // ── 5) 애청지수 ──────────────────────────────────────────
  try {
    const a = j('spoon_act_settings', {});
    const actData = j('spoon_act_data', {});

    const base = {
      enabled: true,
      cmdMyInfo: '!내정보', cmdCreate: '!내정보 생성', cmdDelete: '!내정보 삭제',
      cmdRank: '!랭킹', cmdLotto: '!복권', cmdAttend: '!출석',
      cmdLottoGive: '!복권지급', cmdShop: '!상점', cmdAt: '@',
      grantNicknames: [],
      lvBase: 100,
      scoreHeart: 1, scorePaidHeart: null, scoreChat: 2, scoreAttend: 10, scoreLottoPoint: 5,
      lottoExchange: 22, lotto1st: 3000, lotto2nd: 500, lotto3rd: 100, lottoFail: 1,
      lvUpLottoEnabled: true, lvUpLottoInterval: 10, lvUpLottoAmount: 1,
      autoAttendEnabled: true, autoAttendIntervalMin: 30,
      msgCreate: '✅ {nickname}님의 애청지수 정보가 생성되었습니다!',
      msgDeleteOk: '🗑️ {nickname}님의 애청지수 정보가 삭제되었습니다.',
      msgNoInfo: "⚠️ {nickname}님은 정보가 없습니다. '!내정보 생성' 으로 등록하세요.",
      msgMyInfo: "[ '{nickname}'님 활동정보 ]\n순위 : {rank}위\n레벨 : {level} ({exp}/{nextExp})\n하트 : {heart}\n채팅 : {chat}\n출석 : {attend}\n복권포인트 : {lp}/{lpMax}\n복권 : {lotto}",
      msgRankHeader: '🏆 애청지수 TOP 5 🏆',
      msgRankLine: '{rank}위: {nickname} (Lv.{level})',
      msgLvUpLotto: '🎉 {nickname}님 Lv.{level} 달성! 복권 {amount}장 지급! (보유: {lotto}장)',
      msgLottoHeader: '🎰 {nickname}님의 복권 {count}개 지정 결과',
      msgLottoWin: '🎊당첨번호:{winNums}',
      msgLottoMy: '✨나의번호:{myNums}',
      msgLottoTotal: '🎁 총 획득 경험치: +{totalExp} EXP',
      msgLottoAutoHeader: '🎰 {nickname}님의 복권 {count}개 자동 결과',
      msgLottoFull: '🎟️ {nickname}님 복권 {gained}장 지급! (보유: {lotto}장 | 포인트: {lp}/{lpMax})',
      users: {},
    };

    patch.activity = {
      ...base,
      cmdMyInfo: pick(a.cmdMyInfo, base.cmdMyInfo),
      cmdCreate: pick(a.cmdCreate, base.cmdCreate),
      cmdDelete: pick(a.cmdDelete, base.cmdDelete),
      cmdRank: pick(a.cmdRank, base.cmdRank),
      cmdLotto: pick(a.cmdLotto, base.cmdLotto),
      cmdAttend: pick(a.cmdAttend, base.cmdAttend),
      cmdAt: pick(a.cmdAt, base.cmdAt),
      cmdLottoGive: pick(a.cmdLottoGive, base.cmdLottoGive),
      cmdShop: pick(a.cmdShop, base.cmdShop),
      grantNicknames: Array.isArray(a.grantTags) ? a.grantTags : [],
      lvBase: Number(a.lvBase) || base.lvBase,
      scoreHeart: a.scoreHeart != null ? Number(a.scoreHeart) : base.scoreHeart,
      scorePaidHeart: a.scorePaidHeart != null ? Number(a.scorePaidHeart) : null,
      scoreChat: a.scoreChat != null ? Number(a.scoreChat) : base.scoreChat,
      scoreAttend: a.scoreAttend != null ? Number(a.scoreAttend) : base.scoreAttend,
      scoreLottoPoint: a.scoreLottoPoint != null ? Number(a.scoreLottoPoint) : base.scoreLottoPoint,
      lottoExchange: Number(a.lottoExchange) || base.lottoExchange,
      lotto1st: Number(a.lotto1st) || base.lotto1st,
      lotto2nd: Number(a.lotto2nd) || base.lotto2nd,
      lotto3rd: Number(a.lotto3rd) || base.lotto3rd,
      lottoFail: Number(a.lottoFail) || base.lottoFail,
      lvUpLottoEnabled: a.lvUpLottoEnabled !== false,
      lvUpLottoInterval: Number(a.lvUpLottoInterval) || base.lvUpLottoInterval,
      lvUpLottoAmount: Number(a.lvUpLottoAmount) || base.lvUpLottoAmount,
      autoAttendEnabled: a.autoAttendEnabled !== false,
      autoAttendIntervalMin: Number(a.autoAttendIntervalMin) || base.autoAttendIntervalMin,
      msgMyInfo: pick(a.msgMyInfo, base.msgMyInfo),
    };

    const users = {};
    Object.entries(actData).forEach(([key, d]) => {
      users[key] = {
        nickname: d.nickname || key,
        tag: d.tag || null,
        heart: Number(d.heart) || 0,
        chat: Number(d.chat) || 0,
        attend: Number(d.attend) || 0,
        lp: Number(d.lp) || 0,
        lotto: Number(d.lotto) || 0,
        exp: Number(d.exp) || 0,
        lastAttendTime: Number(d.lastAttendTime) || 0,
      };
    });
    patch.activity.users = users;

    report.push(`✅ 애청지수 설정 + 유저 ${Object.keys(users).length}명 (레벨은 웹봇 공식으로 재계산됨 · EXP는 그대로 보존)`);
  } catch (e) { report.push(`⚠️ 애청지수 마이그레이션 실패: ${e.message}`); }

  // ── 6) 퀴즈 ──────────────────────────────────────────────
  try {
    const q = j('spoon_quiz_settings', {});
    const questions = j('spoon_quiz_questions', []);
    patch.quiz = {
      enabled: false,
      autoStartOnRestart: !!q.autoStart,
      intervalMin: Number(q.intervalMin) || 0,
      intervalSec: Number(q.intervalSec) || 10,
      msgCorrect: q.msgCorrect || '🎉 정답! {nickname}님이 맞추셨습니다!\n+{score} EXP 획득',
      msgTimeout: q.msgTimeout || '⏰ 시간 초과! 정답은 [{answer}]였습니다.',
      msgQuestion: q.msgQuestion || '🧩 퀴즈! {question} (제한시간: {time}초)',
      questions: questions.map(qq => ({
        id: 'q' + uid(),
        question: qq.question,
        answer: qq.answer,
        score: Number(qq.score) || 10,
        timeLimit: Number(qq.time) || 20,
      })),
    };
    report.push(`✅ 퀴즈 문제 ${patch.quiz.questions.length}개`);
  } catch (e) { report.push(`⚠️ 퀴즈 마이그레이션 실패: ${e.message}`); }

  // ── 7) 입장 / 좋아요 / 선물 / 반복문구 / 퇴장 멘트 ───────
  try {
    const auto = j('spoon_auto_settings', {});
    const toEntryItems = (list) => (list || []).map(m => ({
      id: Number(uid().replace('_', '')) || Date.now(),
      enabled: m.enabled !== false,
      target: '',
      text: m.text || '',
      delay: Number(m.delay) || 0,
      sound: '',
    }));
    const toRepeatItems = (list) => (list || []).map(m => {
      const totalSec = Number(m.delay) || 0;
      return {
        id: Number(uid().replace('_', '')) || Date.now(),
        enabled: m.enabled !== false,
        text: m.text || '',
        intervalMin: Math.floor(totalSec / 60),
        intervalSec: totalSec % 60,
      };
    });
    patch.entryData = {
      entry: toEntryItems(auto.join),
      leave: toEntryItems(auto.leave),
      like: toEntryItems(auto.like),
      gift: toEntryItems(auto.gift),
      repeat: toRepeatItems(auto.repeat),
    };
    // 예전 방식(joinMessages/likeMessages/leaveMessages) 필드도 함께 채워서
    // 실제 채팅 발송 로직과 100% 호환되도록 한다.
    patch.joinMessages = patch.entryData.entry.filter(m => m.enabled).map(m => ({ text: m.text, enabled: true }));
    patch.likeMessages = patch.entryData.like.filter(m => m.enabled).map(m => ({ text: m.text, enabled: true }));
    patch.leaveMessages = patch.entryData.leave.filter(m => m.enabled).map(m => ({ text: m.text, enabled: true }));
    if (raw.spoon_auto_join_tag) patch.autoJoinTag = raw.spoon_auto_join_tag;
    report.push(`✅ 입장 ${patch.entryData.entry.length} / 좋아요 ${patch.entryData.like.length} / 선물 ${patch.entryData.gift.length} / 반복문구 ${patch.entryData.repeat.length} / 퇴장 ${patch.entryData.leave.length}`);
  } catch (e) { report.push(`⚠️ 입장설정 마이그레이션 실패: ${e.message}`); }

  // ── 8) 펀딩 / 깃발 ───────────────────────────────────────
  try {
    const fo = j('spoon_funding_options', {});
    patch.funding = {
      cmd: fo.customCmd || '!펀딩',
      showPercent: fo.showPercent !== false,
      showDday: fo.showDday !== false,
      titleTemplate: fo.customHeader || '🎯 진행중인 {month}월 펀딩 🎯',
      itemTemplate: fo.customFormat || '{index}. {title}\n💰{current}/{goal} [{percent}] {dday}',
      items: (j('spoon_fundings', []) || []).map(it => ({
        id: 'fd' + uid(), title: it.title, goal: Number(it.goal) || 0, current: Number(it.current) || 0, endDate: it.endDate || '',
      })),
    };
    patch.flags = {
      cmd: '!깃발',
      items: (j('spoon_flags', []) || []).map(it => ({
        id: 'f' + uid(), title: it.title, goal: Number(it.goal) || 0, current: Number(it.current) || 0,
        mode: it.mode === 'auto' ? 'auto' : 'manual', useCycle: !!it.useCycle,
        template: it.template || '=== {title} ====\n{current}/{goal} {percent}%',
      })),
    };
    report.push(`✅ 펀딩 ${patch.funding.items.length}건, 깃발 ${patch.flags.items.length}건`);
  } catch (e) { report.push(`⚠️ 펀딩/깃발 마이그레이션 실패: ${e.message}`); }

  // ── 9) 룰렛 설정 + 기록 ──────────────────────────────────
  try {
    const rlSettings = j('spoon_roulette_settings', []);
    const list = rlSettings.map(r => ({
      id: 'rl' + uid(),
      name: r.name,
      triggerMode: (r.payout === 'exact' || r.payout === 'distribute') ? r.payout : 'combo',
      triggerAmount: Number(r.amount) || 10,
      triggerSticker: '', triggerStickerPayout: 'combo', triggerStickerCount: 1,
      items: (r.items || []).map(it => ({
        id: 'ri' + uid(), name: it.name, percent: Number(it.prob) || 0, skipHistory: !!it.noLog,
      })),
    }));
    patch.roulette = {
      list,
      resultHeaderTemplate: '[🎡{룰렛명}] {닉네임}님 당첨! 🎉',
      couponUseTemplate: '🎡 {닉네임}님이 룰렛{번호} 권 {수량}개를 사용했습니다! (잔여: {잔여}개)',
      couponLowTemplate: '🎡 {닉네임}님, 룰렛{번호}({룰렛명}) 권이 부족합니다.',
    };
    report.push(`✅ 룰렛 설정 ${list.length}개 (총 항목 ${list.reduce((s, r) => s + r.items.length, 0)}개)`);

    // 룰렛 기록: 인덱스 구멍(예: 1,2,3,5) 그대로 현재 순서에 위치 매핑 — 표본 검증 필요
    const rlHistory = j('spoon_roulette_history', {});
    const rouletteHistory = {};
    let userCount = 0;
    Object.entries(rlHistory).forEach(([tag, rec]) => {
      if (!rec || typeof rec !== 'object') return;
      const nickname = rec._nickname || tag;
      const coupons = {};
      if (rec['룰렛권'] && typeof rec['룰렛권'] === 'object') {
        Object.entries(rec['룰렛권']).forEach(([idx, cnt]) => { coupons[idx] = Number(cnt) || 0; });
      }
      const keepList = {};
      Object.entries(rec).forEach(([k, v]) => {
        if (k === '_nickname' || k === '룰렛권') return;
        if (v && typeof v === 'object') {
          Object.entries(v).forEach(([itemName, cnt]) => {
            keepList[itemName] = (keepList[itemName] || 0) + (Number(cnt) || 0);
          });
        }
      });
      rouletteHistory[nickname] = { coupons, wins: [], keepList, miscList: {}, eventList: {} };
      userCount++;
    });
    patch.rouletteHistory = rouletteHistory;
    report.push(`✅ 룰렛 기록 ${userCount}명 (⚠️ 쿠폰 인덱스는 옛 순서 그대로 옮겼어요 — 표본 확인 권장)`);
  } catch (e) { report.push(`⚠️ 룰렛 마이그레이션 실패: ${e.message}`); }

  return { patch, report };
}

module.exports = { buildMigrationPatch };