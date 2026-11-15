// pirate.js — 🏴‍☠️ 해적 러시안룰렛 (/pirate/:djId) — "해적 러시안룰렛" 모듈
//  · 시청자가 내정보 웹페이지와 같은 채팅 인증을 하고 들어와서 [참가] → 참가한 순서대로 차례가 돌아요
//  · 내 차례에 페이지 채팅창에 구멍 번호(예: 7)를 치면 칼을 꽂아요 · 선장이 숨은 구멍이면 "퉁!" 하고 당첨 (재미용 · 보상/벌칙 없음)
//  · 게임은 메모리에만 있어요 (서버가 다시 켜지면 새 판) · 인증은 내정보 웹페이지 인증과 같아요
//  · /pirate/아이디/register|me 는 index.js 에서 /myinfo/... 로 넘겨서 같은 인증을 써요 (에디냥과 같은 모듈)
'use strict';
const path = require('path');

const DEFAULT_PIRATE = { holes: 18, traps: 1, turnSec: 30 };
const COLORS = ['#e2483d', '#4aa3ff', '#46c46b', '#ffc94a', '#c07bff', '#ff8fb1', '#3fd1c7', '#ff9a3c'];
const MAX_PLAYERS = 20, CHAT_KEEP = 120;

function createPirate({ app, isOn, settings, tagOfWeb, nickOf, photoOf }) {
  const on = (dj) => !!isOn(dj);
  function S(dj) {
    const s = settings(dj) || {};
    if (!s.pirate || typeof s.pirate !== 'object') s.pirate = { ...DEFAULT_PIRATE };
    for (const k of Object.keys(DEFAULT_PIRATE)) if (s.pirate[k] === undefined) s.pirate[k] = DEFAULT_PIRATE[k];
    return s.pirate;
  }
  const games = new Map(); // dj -> 게임 (메모리에만 · 서버가 다시 켜지면 새 판)
  function G(dj) {
    let g = games.get(dj);
    if (!g) { g = { round: 1, phase: 'lobby', holes: 18, traps: [], players: [], turn: 0, turnAt: 0, used: [], loser: null, chat: [], seq: 0, lastSay: new Map() }; games.set(dj, g); }
    return g;
  }
  function say(g, text, cls, by) {
    g.seq += 1;
    g.chat.push({ seq: g.seq, nick: by ? by.nick : '에디냥', tag: by ? by.tag : '', color: by ? by.color || '' : '', img: by ? by.img || '' : '', text, cls: cls || (by ? '' : 'bot'), at: Date.now() });
    if (g.chat.length > CHAT_KEEP) g.chat.splice(0, g.chat.length - CHAT_KEEP);
  }
  const leftOf = (g) => { const u = new Set(g.used.map((x) => x.n)); return [...Array(g.holes)].map((_, i) => i + 1).filter((n) => !u.has(n)); };
  const cur = (g) => (g.phase === 'play' ? g.players[g.turn] : null);
  function newLobby(dj, g) {
    g.round += 1; g.phase = 'lobby'; g.players = []; g.turn = 0; g.used = []; g.traps = []; g.loser = null;
    say(g, '⚓ 새 판이에요! [참가] 를 누르고, 2명 이상 모이면 [시작] 을 눌러주세요');
  }
  function start(dj, g) {
    const cfg = S(dj);
    g.holes = [12, 18, 24].includes(+cfg.holes) ? +cfg.holes : 18;
    const t = Math.max(1, Math.min(2, +cfg.traps || 1)); const traps = new Set();
    while (traps.size < t) traps.add(1 + Math.floor(Math.random() * g.holes));
    g.traps = [...traps]; g.used = []; g.loser = null; g.turn = 0; g.phase = 'play'; g.turnAt = Date.now();
    say(g, `🏴‍☠️ 해적 러시안룰렛 시작! 구멍 1~${g.holes}번 중에 선장 ${t}명이 숨어 있어요 · 참가한 순서대로 내 차례에 채팅창에 번호를 쳐주세요`);
    say(g, `🗡️ ${g.players[0].nick}님 차례예요!`);
  }
  function stab(dj, g, p, n, auto) {
    g.used.push({ n, tag: p.tag, nick: p.nick, color: p.color, at: Date.now() });
    if (g.traps.includes(n)) {
      g.phase = 'over'; g.loser = { tag: p.tag, nick: p.nick, n };
      say(g, `🏴‍☠️💥 퉁!!! ${n}번에서 선장이 튕겨 나왔어요! ${p.nick}님 당첨!`, 'hit');
      return;
    }
    say(g, `😮‍💨 ${p.nick}님 ${n}번${auto ? ' (시간이 지나서 자동)' : ''}… 휴, 살았다! (남은 구멍 ${leftOf(g).length}개)`);
    g.turn = (g.turn + 1) % g.players.length; g.turnAt = Date.now();
    say(g, `🗡️ ${g.players[g.turn].nick}님 차례예요!`);
  }
  // ⏱️ 차례 제한 시간이 지나면 남은 구멍 중 아무 데나 자동으로
  setInterval(() => {
    for (const [dj, g] of games) {
      if (g.phase !== 'play') continue;
      const sec = Math.max(10, Math.min(120, +S(dj).turnSec || 30));
      if (Date.now() - g.turnAt < sec * 1000) continue;
      const left = leftOf(g); const p = cur(g); if (!p || !left.length) continue;
      stab(dj, g, p, left[Math.floor(Math.random() * left.length)], true);
    }
  }, 1000).unref();

  function who(dj, webUserId, withImg) {
    if (!on(dj)) return { error: '해적 러시안룰렛을 찾을 수 없어요. (DJ가 해적 러시안룰렛 모듈을 켜야 해요)', off: true };
    const tag = tagOfWeb(dj, String(webUserId || '').trim());
    if (!tag) return { error: '먼저 인증해주세요', needAuth: true };
    let img = ''; if (withImg) try { img = photoOf(dj, tag) || ''; } catch (_) {}
    return { tag, nick: nickOf(dj, tag), img };
  }
  function view(dj, g, tag, since) {
    const p = cur(g); const cfg = S(dj);
    return {
      success: true, round: g.round, phase: g.phase, holes: g.phase === 'lobby' ? ([12, 18, 24].includes(+cfg.holes) ? +cfg.holes : 18) : g.holes,
      traps: g.phase === 'lobby' ? Math.max(1, Math.min(2, +cfg.traps || 1)) : g.traps.length,
      players: g.players.map((x) => ({ tag: x.tag, nick: x.nick, color: x.color, img: x.img })),
      turn: p ? p.tag : '', turnLeft: p ? Math.max(0, Math.ceil((Math.max(10, Math.min(120, +cfg.turnSec || 30)) * 1000 - (Date.now() - g.turnAt)) / 1000)) : 0,
      used: g.used.map((x) => ({ n: x.n, nick: x.nick, color: x.color })), loser: g.loser,
      reveal: g.phase === 'over' ? g.traps : [], me: tag, joined: g.players.some((x) => x.tag === tag),
      chat: g.chat.filter((m) => m.seq > (+since || 0)), seq: g.seq,
    };
  }

  app.get('/pirate/:djId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pirate.html')));
  app.get('/pirate/:djId/state', (req, res) => {
    const dj = req.params.djId; const w = who(dj, req.query.webUserId);
    if (w.error) return res.json({ success: false, ...w });
    res.json({ ...view(dj, G(dj), w.tag, req.query.since), nick: w.nick });
  });
  app.post('/pirate/:djId/join', (req, res) => {
    const dj = req.params.djId; const w = who(dj, (req.body || {}).webUserId, true);
    if (w.error) return res.json({ success: false, ...w });
    const g = G(dj);
    if (g.phase === 'over') newLobby(dj, g);
    if (g.phase !== 'lobby') return res.json({ success: false, error: '지금 판이 진행 중이에요 · 다음 판에 참가해주세요' });
    if (g.players.some((x) => x.tag === w.tag)) return res.json({ success: true });
    if (g.players.length >= MAX_PLAYERS) return res.json({ success: false, error: `최대 ${MAX_PLAYERS}명까지 참가할 수 있어요` });
    const used = new Set(g.players.map((x) => x.color));
    const p = { tag: w.tag, nick: w.nick, img: w.img, color: COLORS.find((c) => !used.has(c)) || COLORS[g.players.length % COLORS.length] };
    g.players.push(p);
    say(g, `🙋 ${p.nick}님 참가! (${g.players.length}번째)`);
    res.json({ success: true });
  });
  app.post('/pirate/:djId/leave', (req, res) => {
    const dj = req.params.djId; const w = who(dj, (req.body || {}).webUserId);
    if (w.error) return res.json({ success: false, ...w });
    const g = G(dj);
    if (g.phase !== 'lobby') return res.json({ success: false, error: '판이 시작되면 나갈 수 없어요 · 차례가 오면 시간이 지나 자동으로 꽂혀요' });
    const i = g.players.findIndex((x) => x.tag === w.tag);
    if (i >= 0) { const [p] = g.players.splice(i, 1); say(g, `👋 ${p.nick}님 참가 취소`); }
    res.json({ success: true });
  });
  app.post('/pirate/:djId/start', (req, res) => {
    const dj = req.params.djId; const w = who(dj, (req.body || {}).webUserId);
    if (w.error) return res.json({ success: false, ...w });
    const g = G(dj);
    if (g.phase !== 'lobby') return res.json({ success: false, error: '이미 진행 중이에요' });
    if (!g.players.some((x) => x.tag === w.tag)) return res.json({ success: false, error: '참가한 사람만 시작할 수 있어요' });
    if (g.players.length < 2) return res.json({ success: false, error: '2명 이상 모여야 시작할 수 있어요' });
    start(dj, g);
    res.json({ success: true });
  });
  app.post('/pirate/:djId/again', (req, res) => {
    const dj = req.params.djId; const w = who(dj, (req.body || {}).webUserId);
    if (w.error) return res.json({ success: false, ...w });
    const g = G(dj);
    if (g.phase === 'over') newLobby(dj, g);
    res.json({ success: true });
  });
  app.post('/pirate/:djId/chat', (req, res) => {
    const dj = req.params.djId; const b = req.body || {}; const w = who(dj, b.webUserId, true);
    if (w.error) return res.json({ success: false, ...w });
    const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text) return res.json({ success: false, error: '내용을 입력해주세요' });
    const g = G(dj);
    const last = g.lastSay.get(w.tag) || 0;
    if (Date.now() - last < 700) return res.json({ success: false, error: '조금 천천히 쳐주세요' });
    g.lastSay.set(w.tag, Date.now());
    const me = g.players.find((x) => x.tag === w.tag);
    say(g, text, '', { nick: w.nick, tag: w.tag, color: me ? me.color : '', img: w.img });
    const p = cur(g);
    if (p && /^\d{1,2}$/.test(text)) {
      if (p.tag !== w.tag) { if (me) say(g, `⏳ 지금은 ${p.nick}님 차례예요`); }
      else {
        const n = +text;
        if (n < 1 || n > g.holes) say(g, `❓ 1~${g.holes}번 중에서 골라주세요`);
        else if (g.used.some((x) => x.n === n)) { const left = leftOf(g); say(g, `🗡️ ${n}번은 이미 꽂혔어요 · 남은 구멍: ${left.slice(0, 12).join(', ')}${left.length > 12 ? '…' : ''}`); }
        else stab(dj, g, p, n, false);
      }
    }
    res.json({ success: true });
  });

  return { S };
}
createPirate.DEFAULT_PIRATE = DEFAULT_PIRATE;
module.exports = createPirate;
