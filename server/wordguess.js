// wordguess.js — 🧩 꼬맨틀 (단어 맞추기)
//  · DJ 가 설정에 적어 둔 단어 중 하나가 정답 (또는 시작할 때 직접 적기)
//  · 시청자가 방송 채팅에 ":오징어" 처럼 치면 정답과 뜻이 얼마나 가까운지(%) · 몇 위인지 알려주고
//    지금까지 나온 단어 중 가까운 순서 TOP 5 를 채팅에 보여줘요 (여러 명이 연달아 치면 모아서 한 번에)
//  · 정답을 맞히면 그 사람 이름을 알려주고 맞힌 횟수 순위에 올려요
//  · 진행 상태는 메모리에만 · 설정과 순위는 저장
'use strict';
const createWordVec = require('./wordvec');

const DEFAULT_WORDGUESS = {
  words: [],            // 정답 후보 (DJ 가 정해요)
  top: 5,               // 채팅에 보여줄 순위 개수 (1~5)
  msgStart: '🧩 꼬맨틀 시작! 정답과 뜻이 가까운 단어를 채팅에 :단어 로 쳐주세요 (예 :오징어)\n힌트 · 1위 {top1}% · 10위 {top10}% · 1000위 {top1000}%',
  msgCorrect: '🎉 {nickname}님 정답! [{answer}] · 추측 {guesses}번 · 참여 {people}명 (누적 {count}번)',
  msgReveal: '🧩 꼬맨틀 끝! 정답은 [{answer}] 였어요',
  scores: {},           // 고유닉 → { nick, n }
};
const FLUSH_MS = 1500;   // 여러 명이 연달아 치면 이만큼 모아서 한 번에 보내요
const LINE_MAX = 100;    // 채팅 한 번에 100자 · 5줄까지
const LINES_MAX = 5;

module.exports = function createWordGuess({ app, store, requireAuth, say, dataDir, binUrls, serveBin }) {
  const vec = createWordVec({ dataDir, binUrls });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const modOn = (dj) => store.mods(dj).wordguess === true;
  function S(dj) {
    const s = store.settings(dj);
    if (!s.wordguess || typeof s.wordguess !== 'object') s.wordguess = clone(DEFAULT_WORDGUESS);
    const D = s.wordguess;
    for (const k of Object.keys(DEFAULT_WORDGUESS)) if (D[k] === undefined) D[k] = clone(DEFAULT_WORDGUESS[k]);
    if (!D.scores || typeof D.scores !== 'object') D.scores = {};
    return D;
  }
  const fmt = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m));
  const pct = (s) => (Math.round(s * 10000) / 100).toFixed(2);
  const short = (t, n) => { const a = [...String(t || '')]; return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
  // 줄들을 100자 · 5줄 안으로 나눠서 보내요
  function sayLines(dj, lines) {
    let cur = [];
    const flush = () => { if (cur.length) say(dj, cur.join('\n')); cur = []; };
    for (const l of lines.filter(Boolean)) {
      if (cur.length >= LINES_MAX || [...cur, l].join('\n').length > LINE_MAX) flush();
      cur.push(l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l);
    }
    flush();
  }

  // 방송별 진행 상태 (메모리) · state: idle · playing · solved · revealed
  const st = new Map();
  function R(dj) {
    let r = st.get(dj);
    if (!r) { r = { state: 'idle', word: '', b: null, guesses: new Map(), people: new Set(), count: 0, last: null, unknown: [], outT: null, winner: null, used: [], startAt: 0 }; st.set(dj, r); }
    return r;
  }
  const list = (r, n) => [...r.guesses.values()].sort((a, b) => b.sim - a.sim).slice(0, n);
  const rankText = (e) => (e.rank ? `${e.rank}위` : '1000위 밖');
  function out(dj) {
    const r = R(dj); r.outT = null;
    if (r.state !== 'playing') return;
    const D = S(dj); const n = Math.max(1, Math.min(5, Number(D.top) || 5));
    const lines = [];
    if (r.unknown.length) lines.push(`❓ ${r.unknown.slice(0, 4).map((w) => `'${short(w, 8)}'`).join(' ')} — 없는 단어예요`);
    r.unknown = [];
    if (r.last) {
      const e = r.last; r.last = null;
      lines.push(`🔎 ${short(e.byNick, 8)} · ${e.word} ${pct(e.sim)}% (${rankText(e)})`);
      sayLines(dj, lines);
      const top = list(r, n);
      sayLines(dj, [`📋 TOP${n} · 추측 ${r.count} · 참여 ${r.people.size}`, ...top.map((x, i) => `${i + 1}. ${x.word} ${pct(x.sim)}% ${short(x.nick, 6)}`)]);
      return;
    }
    sayLines(dj, lines);
  }
  const later = (dj) => { const r = R(dj); if (!r.outT) r.outT = setTimeout(() => out(dj), FLUSH_MS); };

  async function start(dj, word) {
    const r = R(dj); const D = S(dj);
    if (!(await vec.ensure())) return { error: vec.status().note };
    let w = String(word || '').replace(/\s+/g, '').slice(0, 12);
    if (w && !vec.has(w)) return { error: `'${w}' 은(는) 단어 사전에 없어요 — 다른 단어로 해주세요` };
    if (!w) {
      const all = (D.words || []).filter((x) => vec.has(x));
      if (!all.length) return { error: (D.words || []).length ? '적어 둔 단어가 전부 단어 사전에 없어요 — 다른 단어를 적어주세요' : '정답 단어가 없어요 — 단어를 먼저 적어주세요' };
      let pool = all.filter((x) => !r.used.includes(x));
      if (!pool.length) { r.used = []; pool = all; }
      w = pool[Math.floor(Math.random() * pool.length)];
    }
    r.used.push(w); if (r.used.length > 500) r.used.splice(0, r.used.length - 500);
    clearTimeout(r.outT);
    Object.assign(r, { state: 'playing', word: w, b: vec.board(w), guesses: new Map(), people: new Set(), count: 0, last: null, unknown: [], outT: null, winner: null, startAt: Date.now() });
    say(dj, fmt(D.msgStart || DEFAULT_WORDGUESS.msgStart, { top1: pct(r.b.top(1)), top10: pct(r.b.top(10)), top1000: pct(r.b.top(1000)) }));
    return { ok: true, word: w };
  }
  function finish(dj, state) { const r = R(dj); clearTimeout(r.outT); r.outT = null; r.state = state; }

  // 💬 방송 채팅 — ":단어" 면 true (다른 모듈로 안 넘겨요)
  function onChat(dj, e, text, nick, handle) {
    if (!modOn(dj)) return false;
    const r = st.get(dj);
    if (!r || r.state !== 'playing') return false;
    const t = String(text || '').trim();
    if (!/^[:：]/.test(t)) return false;
    const w = t.slice(1).replace(/\s+/g, '');
    if (!w || [...w].length > 12) return false;
    const key = handle || ('#' + ((e && e.user && e.user.id) || nick));
    r.count++; r.people.add(key);
    if (w === r.word) {
      const D = S(dj);
      const sc = D.scores[key] || (D.scores[key] = { nick: '', n: 0 });
      sc.nick = nick || sc.nick; sc.n = (sc.n || 0) + 1;
      store.save(dj);
      r.winner = { nick: nick || '', handle: handle || '' };
      const people = r.people.size; const guesses = r.count;
      finish(dj, 'solved');
      say(dj, fmt(D.msgCorrect || DEFAULT_WORDGUESS.msgCorrect, { nickname: nick || '', answer: r.word, count: sc.n, guesses, people }));
      return true;
    }
    let g = r.guesses.get(w);
    if (!g) {
      const s = r.b && r.b.sim(w);
      if (s === null || s === undefined) { if (!r.unknown.includes(w)) r.unknown.push(w); later(dj); return true; }
      g = { word: w, sim: s, rank: r.b.rank(s), nick: nick || '', handle: handle || '' };
      r.guesses.set(w, g);
    }
    r.last = { ...g, byNick: nick || '' };
    later(dj);
    return true;
  }

  function pub(dj) {
    const r = R(dj);
    return {
      state: r.state, count: r.count, people: r.people.size, winner: r.winner, startAt: r.startAt,
      top: list(r, 20).map((x) => ({ word: x.word, pct: pct(x.sim), rank: x.rank, nick: x.nick })),
      hint: r.b ? { top1: pct(r.b.top(1)), top10: pct(r.b.top(10)), top1000: pct(r.b.top(1000)) } : null,
      rank: Object.entries(S(dj).scores).map(([h, v]) => ({ handle: h, nick: v.nick || h, n: v.n || 0 })).sort((a, b) => b.n - a.n).slice(0, 10),
      dict: vec.status(),
    };
  }

  // ─── DJ (대시보드) ───
  app.get('/api/wordguess', requireAuth, (req, res) => {
    const dj = req.djId; const D = S(dj); const r = R(dj);
    if (modOn(dj)) vec.ensure(); // (켜져 있으면 미리 사전을 열어둬요)
    res.json({ settings: { words: D.words, top: D.top, msgStart: D.msgStart, msgCorrect: D.msgCorrect, msgReveal: D.msgReveal }, status: { ...pub(dj), word: r.word }, moduleOn: modOn(dj) });
  });
  app.put('/api/wordguess', requireAuth, (req, res) => {
    const D = S(req.djId); const b = req.body || {};
    if (Array.isArray(b.words)) D.words = [...new Set(b.words.map((w) => String(w || '').replace(/\s+/g, '').slice(0, 12)).filter(Boolean))].slice(0, 500);
    if (b.top !== undefined) D.top = Math.max(1, Math.min(5, Math.floor(Number(b.top)) || 5));
    for (const k of ['msgStart', 'msgCorrect', 'msgReveal']) if (b[k] !== undefined) D[k] = String(b[k] || '').slice(0, 300) || DEFAULT_WORDGUESS[k];
    store.save(req.djId);
    const missing = vec.status().state === 'ready' ? D.words.filter((w) => !vec.has(w)) : [];
    res.json({ ok: true, missing });
  });
  app.post('/api/wordguess/start', requireAuth, async (req, res) => {
    if (!modOn(req.djId)) return res.status(400).json({ error: '🧩 꼬맨틀 모듈이 꺼져 있어요' });
    const o = await start(req.djId, (req.body || {}).word);
    if (o.error) return res.status(400).json(o);
    res.json({ ...o, status: pub(req.djId) });
  });
  app.post('/api/wordguess/reveal', requireAuth, (req, res) => {
    const dj = req.djId; const r = R(dj);
    if (r.state === 'playing') { finish(dj, 'revealed'); say(dj, fmt(S(dj).msgReveal || DEFAULT_WORDGUESS.msgReveal, { answer: r.word })); }
    res.json({ ok: true, status: pub(dj) });
  });
  app.post('/api/wordguess/stop', requireAuth, (req, res) => {
    const dj = req.djId; const r = R(dj);
    finish(dj, 'idle'); Object.assign(r, { word: '', b: null, guesses: new Map(), people: new Set(), count: 0, winner: null });
    res.json({ ok: true, status: pub(dj) });
  });
  app.post('/api/wordguess/reset-rank', requireAuth, (req, res) => { S(req.djId).scores = {}; store.save(req.djId); res.json({ ok: true }); });
  // 💻 PC 프로그램으로 봇을 돌리는 방 — 진행 중엔 PC 가 ":단어" 채팅을 여기로 보내줘요
  app.post('/api/wordguess/answer', requireAuth, (req, res) => {
    const b = req.body || {};
    const ok = onChat(req.djId, { isDj: false, user: { id: b.uid } }, String(b.text || '').slice(0, 60), String(b.nick || '').slice(0, 60), String(b.handle || '').slice(0, 60));
    res.json({ ok: true, used: ok });
  });
  // 📦 다른 서버가 받아 갈 단어 사전 파일
  if (serveBin) app.get('/api/wordguess/vec.bin', (req, res) => { const f = vec.filePath(); if (!f) return res.status(503).json({ error: '아직 준비 중' }); res.sendFile(f); });

  const playing = (dj) => { const r = st.get(dj); return !!(r && r.state === 'playing' && modOn(dj)); };
  return { S, onChat, pub, start, playing, vec };
};
module.exports.DEFAULT_WORDGUESS = DEFAULT_WORDGUESS;
