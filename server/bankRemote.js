// bankRemote.js — 🏦 충전금 (공식 에디냥이 입금 알림을 받아서 넘겨주는 쪽)
//  · DJ 마다 6자리 입금 코드 (비공식 에디냥 6xxxxx · 짜잔에디봇 7xxxxx) — 입금자명에 이 코드를 적고 입금
//  · 공식 에디냥 서버가 입금 알림에서 이 코드를 보면 /api/bank/credit 로 넘겨줘요 (연결 키로 확인)
//  · 이용 기간이 끝날 때(또는 끝났거나 3일 안 남았을 때 충전하면 바로) 요금제 금액을 빼고 30일 연장
//      일반 DJ 10,000원 · Choice 20,000원 — 스푼 프로필로 초이스 DJ 인지 확인(스푼 번호를 알 때) · 관리자가 고정 가능
//  (공식 에디냥 bankpay.js 와 같은 규칙 · 서버마다 adapter 만 달라요)
'use strict';
const crypto = require('crypto');

const PLANS = { normal: { name: '일반 DJ', fee: 10000 }, choice: { name: 'Choice', fee: 20000 } };
const DAYS = 30;
const SOON = 3 * 86400e3;
const SP_HOST = 'https://kr-api.spooncast.net';
const SP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// A (adapter): { prefix, ids(), get(id), save(id), expiryOf(id), extend(id, days), unlimited(id), tagOf(id), discord(msg), getKey(), setKey(k), name }
module.exports = function createBankRemote(A) {
  const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
  const when = (t) => (t ? new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '무제한');
  function key() { let k = A.getKey(); if (!k) { k = crypto.randomBytes(18).toString('base64url'); A.setKey(k); } return k; }

  function codeOf(id) {
    const u = A.get(id); if (!u) return '';
    if (u.payCode && new RegExp(`^${A.prefix}\\d{5}$`).test(u.payCode)) return u.payCode;
    const used = new Set(A.ids().map((x) => (A.get(x) || {}).payCode).filter(Boolean));
    let c; do { c = A.prefix + String(crypto.randomInt(100000)).padStart(5, '0'); } while (used.has(c));
    u.payCode = c; A.save(id);
    return c;
  }
  const byCode = (c) => A.ids().find((id) => { const u = A.get(id); return u && u.payCode === String(c); });

  const planOf = (u) => (u && PLANS[u.planForce]) ? u.planForce : (u && u.spoonChoice && u.spoonChoice.v === true ? 'choice' : 'normal');
  function choiceIn(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 4) return null;
    let found = null;
    for (const [k, v] of Object.entries(o)) {
      if (/choice/i.test(k) && typeof v === 'boolean') { if (v) return true; found = false; }
      else if (/choice/i.test(k) && v && typeof v === 'object') { const x = choiceIn(v, depth + 1); if (x !== null) return x; found = false; }
      else if (typeof v === 'string' && /^(tier|badge|grade|level|type|name|title|style)/i.test(k) && /choice/i.test(v)) return true;
      else if (v && typeof v === 'object') { const x = choiceIn(v, depth + 1); if (x === true) return true; }
    }
    return found;
  }
  // 🔍 스푼 프로필 — 고유닉으로 스푼 검색(kr-gw)해서 그 사람을 찾고, 찾은 스푼 번호로 프로필(kr-api)도 같이 받아요
  //   (공식 API 의 유저 번호는 스푼 웹 번호와 달라서 /users/번호 로 바로 물어보면 404 가 나와요)
  async function spoonLookup(tag) {
    const want = String(tag || '').replace(/^@/, '').trim().toLowerCase();
    if (!want) throw new Error('DJ 고유닉을 몰라요');
    const H = { 'User-Agent': SP_UA, Origin: 'https://www.spooncast.net', Referer: 'https://www.spooncast.net/', Accept: 'application/json', 'X-Client-App': 'sopia-web', 'X-Client-Version': '1.0.0' };
    let url = `https://kr-gw.spooncast.net/search/user?keyword=${encodeURIComponent(want)}&page_size=20`; let m = null;
    for (let page = 0; url && page < 5 && !m; page++) {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('스푼 검색 응답 ' + r.status);
      const j = await r.json();
      m = (j.results || []).find((u) => String(u.tag || '').toLowerCase() === want) || null;
      url = typeof j.next === 'string' && j.next ? j.next : null;
    }
    if (!m) throw new Error(`스푼 검색에 @${want} 이 없어요`);
    let profile = null;
    try { const r = await fetch(`${SP_HOST}/users/${encodeURIComponent(m.id)}/`, { headers: H, signal: AbortSignal.timeout(10000) }); if (r.ok) { const j = await r.json(); profile = (j && Array.isArray(j.results) ? j.results[0] : j) || null; } } catch (_) {}
    return { uid: m.id, search: m, profile };
  }
  async function detectChoice(id, force, raw) {
    const u = A.get(id); if (!u) return null;
    if (!force && u.spoonChoice && Date.now() - u.spoonChoice.at < 12 * 3600e3) return u.spoonChoice.v;
    const tag = A.tagOf(id);
    if (!tag) { if (raw) raw.error = 'DJ 고유닉을 몰라요'; return u.spoonChoice ? u.spoonChoice.v : null; }
    try {
      const L = await spoonLookup(tag); const v = choiceIn(L) === true;
      const u2 = A.get(id); if (u2) { u2.spoonChoice = { v, at: Date.now() }; u2.spoonUid = String(L.uid); A.save(id); }
      if (raw) Object.assign(raw, { tag, ...L, choice: v });
      return v;
    } catch (e) { if (raw) raw.error = e.message; const u2 = A.get(id); return u2 && u2.spoonChoice ? u2.spoonChoice.v : null; }
  }

  function renew(id, why) {
    const u = A.get(id); if (!u || A.unlimited(id) || !A.expiryOf(id)) return null;
    const plan = PLANS[planOf(u)];
    if ((u.wallet || 0) < plan.fee) return null;
    u.wallet -= plan.fee; u.lastPaidAt = Date.now(); u.lowWarnAt = 0;
    A.extend(id, DAYS); A.save(id);
    const exp = when(A.expiryOf(id));
    A.discord(`🔁 **충전금으로 연장** (${A.name}) · **${id}** ${plan.name} ${DAYS}일 (-${won(plan.fee)})\n남은 충전금 ${won(u.wallet)} · 새 만료일 ${exp}${why ? `\n(${why})` : ''}`);
    return { plan: plan.name, days: DAYS, fee: plan.fee, wallet: u.wallet, exp };
  }
  function credit(id, amount, how) {
    const u = A.get(id); if (!u) return null;
    u.wallet = (u.wallet || 0) + amount; A.save(id);
    A.discord(`💰 **충전** (${A.name}) · **${id}** +${won(amount)} (${how}) → 충전금 ${won(u.wallet)}`);
    let r = null;
    const exp = A.expiryOf(id);
    if (exp && exp - Date.now() < SOON) r = renew(id, '충전하자마자');
    detectChoice(id).catch(() => {});
    return { wallet: u.wallet, renewed: r };
  }

  let sweeping = false;
  async function sweep() {
    if (sweeping) return; sweeping = true;
    try {
      const now = Date.now();
      for (const id of A.ids()) {
        let u = A.get(id); const exp = A.expiryOf(id);
        if (!u || !exp || !u.wallet || A.unlimited(id)) continue;
        if (exp - now < SOON) { await detectChoice(id); u = A.get(id); if (!u) continue; }
        if (exp - now < 3600e3) { renew(id, '이용 기간 끝나서 자동'); continue; }
        const fee = PLANS[planOf(u)].fee;
        if (exp - now < SOON && u.wallet < fee && !(u.lowWarnAt > now - SOON)) {
          u.lowWarnAt = now; A.save(id);
          A.discord(`🔔 **충전금 부족** (${A.name}) · **${id}** 만료 ${when(exp)} · 충전금 ${won(u.wallet)} (필요 ${won(fee)})`);
        }
      }
    } finally { sweeping = false; }
  }
  setInterval(sweep, 3600e3).unref();
  setTimeout(sweep, 90e3).unref();

  const mine = (id) => { const u = A.get(id) || {}; const plan = planOf(u); return { code: codeOf(id), wallet: u.wallet || 0, plan, planName: PLANS[plan].name, fee: PLANS[plan].fee, how: PLANS[u.planForce] ? '관리자가 정함' : (u.spoonChoice ? '스푼 프로필에서 확인' : '아직 확인 전 (일반으로 계산)'), days: DAYS, plans: PLANS }; };

  // 🔀 공식 에디냥 → 여기 (연결 키)
  function creditRoute(req, res) {
    const b = req.body || {};
    const k = String(b.key || ''); const want = key();
    if (!k || k.length !== want.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) return res.status(403).json({ ok: false, error: '연결 키가 달라요' });
    const amount = Math.round(Number(b.amount) || 0);
    if (!(amount > 0)) return res.status(400).json({ ok: false, error: '금액이 없어요' });
    const id = byCode(String(b.code || ''));
    if (!id) return res.status(404).json({ ok: false, error: `입금 코드 ${b.code} 인 DJ 가 없어요` });
    const c = credit(id, amount, `입금 코드 ${b.code}`);
    res.json({ ok: true, id, wallet: c.wallet, exp: c.renewed ? c.renewed.exp : '' });
  }
  function adminList() {
    return { key: key(), wallets: A.ids().map((id) => ({ id, u: A.get(id) })).filter((x) => x.u && (x.u.wallet || x.u.payCode))
      .map(({ id, u }) => ({ id, tag: A.tagOf(id), code: codeOf(id), wallet: u.wallet || 0, plan: planOf(u), force: u.planForce || '', spoon: u.spoonChoice ? u.spoonChoice.v : null, exp: A.expiryOf(id) || null }))
      .sort((a, b) => b.wallet - a.wallet) };
  }
  function adminPlan(id, plan) { const u = A.get(id); if (!u) return null; if (PLANS[plan]) u.planForce = plan; else delete u.planForce; A.save(id); return planOf(u); }
  function adminWallet(id, delta) { const u = A.get(id); if (!u) return null; u.wallet = Math.max(0, (u.wallet || 0) + Math.round(Number(delta) || 0)); A.save(id); return u.wallet; }
  function rekey() { A.setKey(''); return key(); }

  return { key, codeOf, credit, renew, sweep, mine, creditRoute, adminList, adminPlan, adminWallet, rekey, detectChoice, PLANS };
};
