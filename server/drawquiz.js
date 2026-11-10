// drawquiz.js — 🎨 그림 퀴즈
//  · DJ 가 대시보드 [🎨 그림 퀴즈] 에서 그림을 그리면, 시청자는 그림 퀴즈 웹페이지(/drawquiz/아이디)에서 실시간으로 봐요
//  · 정답은 방송 채팅에 쳐요 — 제일 먼저 맞힌 사람을 채팅에 알려주고 맞힌 횟수 순위에 올려요
//  · 그림(선)은 메모리에만 · 순위는 설정에 저장
'use strict';

const DEFAULT_DRAWQUIZ = {
  words: [],            // 문제 (DJ 가 정해요)
  time: 120,            // 문제당 시간(초)
  hint: true,           // 시청자에게 글자 수 보여주기
  msgStart: '🎨 그림 퀴즈! DJ 가 그리는 그림을 보고 정답을 채팅에 쳐주세요 ({len}글자 · {time}초)\n👉 {url}',
  msgCorrect: '🎉 {nickname}님 정답! [{answer}] (누적 {count}번)',
  msgTimeout: '⏰ 시간 끝! 정답은 [{answer}]였어요',
  scores: {},           // 고유닉 → { nick, n }
};
const MAX_OPS = 30000;          // 한 문제 그림 크기 한도 (선 조각 수)
const LONGPOLL_MS = 20000;

module.exports = function createDrawQuiz({ app, store, requireAuth, say, publicUrl }) {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const modOn = (dj) => store.mods(dj).drawquiz === true;
  function S(dj) {
    const s = store.settings(dj);
    if (!s.drawquiz || typeof s.drawquiz !== 'object') s.drawquiz = clone(DEFAULT_DRAWQUIZ);
    const D = s.drawquiz;
    for (const k of Object.keys(DEFAULT_DRAWQUIZ)) if (D[k] === undefined) D[k] = clone(DEFAULT_DRAWQUIZ[k]);
    if (!D.scores || typeof D.scores !== 'object') D.scores = {};
    return D;
  }
  const norm = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();
  const fmt = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m));
  // (서버 주소를 모르면 DJ 가 대시보드를 연 주소를 기억해서 써요)
  const baseOf = new Map();
  const seen = (req) => { if (!publicUrl && req && req.djId) baseOf.set(req.djId, `${String(req.get('x-forwarded-proto') || req.protocol).split(',')[0]}://${req.get('host')}`); };
  const pageUrl = (dj) => `${publicUrl || baseOf.get(dj) || ''}/drawquiz/${encodeURIComponent(dj)}`;

  // 방송별 진행 상태 (메모리)
  //  state: idle(문제 없음) · playing(진행 중) · solved(누가 맞힘) · timeout(시간 끝) · revealed(DJ 가 공개)
  const st = new Map();
  function R(dj) {
    let r = st.get(dj);
    if (!r) { r = { state: 'idle', word: '', startAt: 0, endsAt: 0, winner: null, epoch: 1, ops: [], tOut: null, waiters: new Set(), used: [] }; st.set(dj, r); }
    return r;
  }
  function wake(dj) {
    const r = R(dj);
    for (const w of r.waiters) { try { w(); } catch (_) {} }
    r.waiters.clear();
  }
  function rank(dj, n = 10) {
    return Object.entries(S(dj).scores).map(([h, v]) => ({ handle: h, nick: v.nick || h, n: v.n || 0 })).sort((a, b) => b.n - a.n).slice(0, n);
  }
  // 시청자에게 보여줄 상태 (정답은 끝났을 때만)
  function pub(dj) {
    const r = R(dj); const D = S(dj);
    const done = r.state === 'solved' || r.state === 'timeout' || r.state === 'revealed';
    return {
      on: modOn(dj), state: r.state, epoch: r.epoch, seq: r.ops.length,
      len: r.word && D.hint ? [...r.word.replace(/\s+/g, '')].length : 0,
      answer: done ? r.word : '', winner: r.winner, endsAt: r.state === 'playing' ? r.endsAt : 0, now: Date.now(),
      rank: rank(dj),
    };
  }
  function finish(dj, state) {
    const r = R(dj);
    clearTimeout(r.tOut); r.tOut = null;
    r.state = state;
    wake(dj);
  }
  function start(dj, word) {
    const r = R(dj); const D = S(dj);
    let w = String(word || '').trim().slice(0, 30);
    if (!w) {
      const pool = (D.words || []).filter((x) => x && !r.used.includes(x));
      const list = pool.length ? pool : (D.words || []).filter(Boolean);
      if (!list.length) return { error: '문제가 없어요 — 문제를 먼저 적어주세요' };
      if (!pool.length) r.used = [];
      w = list[Math.floor(Math.random() * list.length)];
    }
    r.used.push(w); if (r.used.length > 500) r.used.splice(0, r.used.length - 500);
    clearTimeout(r.tOut);
    const time = Math.max(10, Math.min(900, Number(D.time) || 120));
    Object.assign(r, { state: 'playing', word: w, startAt: Date.now(), endsAt: Date.now() + time * 1000, winner: null, ops: [] });
    r.epoch++;
    r.tOut = setTimeout(() => {
      if (r.state !== 'playing') return;
      finish(dj, 'timeout');
      say(dj, fmt(S(dj).msgTimeout || DEFAULT_DRAWQUIZ.msgTimeout, { answer: r.word }));
    }, time * 1000);
    say(dj, fmt(D.msgStart || DEFAULT_DRAWQUIZ.msgStart, { len: [...w.replace(/\s+/g, '')].length, time, url: pageUrl(dj) }));
    wake(dj);
    return { ok: true, word: w };
  }

  // 💬 방송 채팅 — 정답이면 true (다른 모듈로 안 넘겨요)
  function onChat(dj, e, text, nick, handle) {
    if (!modOn(dj)) return false;
    const r = st.get(dj);
    if (!r || r.state !== 'playing' || !r.word) return false;
    if (e && e.isDj) return false; // (DJ 는 그리는 사람이라 정답 처리 안 해요)
    if (norm(text) !== norm(r.word)) return false;
    const D = S(dj);
    const key = handle || ('#' + ((e && e.user && e.user.id) || nick));
    const sc = D.scores[key] || (D.scores[key] = { nick: '', n: 0 });
    sc.nick = nick || sc.nick; sc.n = (sc.n || 0) + 1;
    store.save(dj);
    r.winner = { nick: nick || '', handle: handle || '' };
    finish(dj, 'solved');
    say(dj, fmt(D.msgCorrect || DEFAULT_DRAWQUIZ.msgCorrect, { nickname: nick || '', answer: r.word, count: sc.n }));
    return true;
  }

  // ─── DJ (대시보드) ───
  app.get('/api/drawquiz', requireAuth, (req, res) => {
    seen(req); const dj = req.djId; const r = R(dj); const D = S(dj);
    res.json({ settings: { words: D.words, time: D.time, hint: D.hint, msgStart: D.msgStart, msgCorrect: D.msgCorrect, msgTimeout: D.msgTimeout },
      status: { ...pub(dj), word: r.word }, url: pageUrl(dj), moduleOn: modOn(dj) });
  });
  app.put('/api/drawquiz', requireAuth, (req, res) => {
    const D = S(req.djId); const b = req.body || {};
    if (Array.isArray(b.words)) D.words = [...new Set(b.words.map((w) => String(w || '').trim().slice(0, 30)).filter(Boolean))].slice(0, 500);
    if (b.time !== undefined) D.time = Math.max(10, Math.min(900, Math.floor(Number(b.time)) || 120));
    if (b.hint !== undefined) D.hint = !!b.hint;
    for (const k of ['msgStart', 'msgCorrect', 'msgTimeout']) if (b[k] !== undefined) D[k] = String(b[k] || '').slice(0, 300) || DEFAULT_DRAWQUIZ[k];
    store.save(req.djId);
    res.json({ ok: true });
  });
  app.post('/api/drawquiz/start', requireAuth, (req, res) => {
    seen(req);
    if (!modOn(req.djId)) return res.status(400).json({ error: '🎨 그림 퀴즈 모듈이 꺼져 있어요' });
    const out = start(req.djId, (req.body || {}).word);
    if (out.error) return res.status(400).json(out);
    res.json({ ...out, status: pub(req.djId) });
  });
  app.post('/api/drawquiz/reveal', requireAuth, (req, res) => {
    const dj = req.djId; const r = R(dj);
    if (r.state !== 'playing') return res.json({ ok: true, status: pub(dj) });
    finish(dj, 'revealed');
    say(dj, fmt(S(dj).msgTimeout || DEFAULT_DRAWQUIZ.msgTimeout, { answer: r.word }));
    res.json({ ok: true, status: pub(dj) });
  });
  app.post('/api/drawquiz/stop', requireAuth, (req, res) => {
    const dj = req.djId; const r = R(dj);
    clearTimeout(r.tOut); r.tOut = null;
    Object.assign(r, { state: 'idle', word: '', winner: null, ops: [] }); r.epoch++;
    wake(dj);
    res.json({ ok: true, status: pub(dj) });
  });
  app.post('/api/drawquiz/reset-rank', requireAuth, (req, res) => { S(req.djId).scores = {}; store.save(req.djId); wake(req.djId); res.json({ ok: true }); });
  // ✏️ 그림 조각 — ops: [{t:'s', c:'#000', w:6, p:[x,y,...]} 새 선 · {t:'a', p:[...]} 이어 그리기 · {t:'u'} 되돌리기 · {t:'c'} 전부 지우기]
  //   (좌표는 1000×750 캔버스 기준 정수)
  app.post('/api/drawquiz/draw', requireAuth, (req, res) => {
    const dj = req.djId; const r = R(dj);
    const ops = Array.isArray((req.body || {}).ops) ? req.body.ops.slice(0, 200) : [];
    const pts = (p) => (Array.isArray(p) ? p.slice(0, 2000).map((v) => Math.max(-50, Math.min(1050, Math.round(Number(v) || 0)))) : []);
    for (const o of ops) {
      if (!o || r.ops.length >= MAX_OPS) break;
      if (o.t === 's') r.ops.push({ t: 's', c: /^#[0-9a-f]{6}$/i.test(o.c) ? o.c : '#222222', w: Math.max(1, Math.min(80, Math.round(Number(o.w) || 6))), p: pts(o.p) });
      else if (o.t === 'a') { const p = pts(o.p); if (p.length) r.ops.push({ t: 'a', p }); }
      else if (o.t === 'u') r.ops.push({ t: 'u' });
      else if (o.t === 'c') r.ops.push({ t: 'c' });
    }
    if (ops.length) wake(dj);
    res.json({ ok: true, seq: r.ops.length, full: r.ops.length >= MAX_OPS });
  });

  // ─── 시청자 웹페이지 — 로그인 없이 보기만
  app.get('/drawquiz/:djId', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'drawquiz.html')));
  // (상태) · 새 그림이 올 때까지 최대 20초 기다렸다 답해요 ───
  app.get('/drawquiz/:djId/state', (req, res) => {
    const dj = String(req.params.djId || '');
    if (store.exists ? !store.exists(dj) : !store.db.users[dj]) return res.status(404).json({ on: false });
    if (!modOn(dj)) return res.json({ on: false });
    const r = R(dj);
    const ep = Number(req.query.epoch) || 0; const seq = Number(req.query.seq) || 0; const wait = req.query.wait === '1';
    const reply = () => {
      if (res.headersSent) return;
      const p = pub(dj);
      if (ep !== r.epoch || seq > r.ops.length) res.json({ ...p, reset: true, ops: r.ops });
      else res.json({ ...p, ops: r.ops.slice(seq) });
    };
    const fresh = ep !== r.epoch || seq !== r.ops.length;
    if (!wait || fresh) return reply();
    const t = setTimeout(() => { r.waiters.delete(done); reply(); }, LONGPOLL_MS);
    const done = () => { clearTimeout(t); setTimeout(reply, 60); }; // (선 조각을 조금 모아서 보내요)
    r.waiters.add(done);
    req.on('close', () => { clearTimeout(t); r.waiters.delete(done); });
  });

  // 💻 PC 프로그램으로 봇을 돌리는 방 — 채팅을 PC 가 받으니까, 문제 진행 중엔 PC 가 시청자 채팅을 여기로 보내줘요
  app.post('/api/drawquiz/answer', requireAuth, (req, res) => {
    const b = req.body || {};
    const ok = onChat(req.djId, { isDj: false }, String(b.text || '').slice(0, 200), String(b.nick || '').slice(0, 60), String(b.handle || '').slice(0, 60));
    res.json({ ok: true, correct: ok });
  });
  const playing = (dj) => { const r = st.get(dj); return !!(r && r.state === 'playing' && modOn(dj)); };

  return { S, onChat, pub, start, playing };
};
module.exports.DEFAULT_DRAWQUIZ = DEFAULT_DRAWQUIZ;
