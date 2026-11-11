// wordvec.js — 🧩 단어 맞추기용 한국어 단어 벡터
//  · 처음 한 번 페이스북 fastText 한국어 단어 벡터(cc.ko.300)에서 자주 쓰는 한글 단어만 골라 받아서
//    작게 줄여(단어당 300바이트) 서버 데이터 폴더에 저장해요 → 다음부터는 그 파일만 읽어요
//  · 다른 서버(비공식 에디냥 · 짜잔에디봇)는 공식 에디냥이 만들어 둔 파일(/api/wordguess/vec.bin)을 먼저 받아봐요
//  · 두 단어가 뜻이 얼마나 가까운지 = 코사인 유사도 (단어 맞추기처럼 ×100 해서 % 로 보여줘요)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const DIM = 300;
const KEEP = Number(process.env.WORDVEC_KEEP) || 50000;          // 남길 한글 단어 수
const MAX_LINES = Number(process.env.WORDVEC_MAX_LINES) || 400000; // fastText 파일에서 최대 몇 줄까지 읽을지 (자주 쓰는 순서)
const FT_URL = process.env.WORDVEC_URL || 'https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.ko.300.vec.gz';
const MAGIC = 'WV01';
const WORD_RE = /^[가-힣]{1,8}$/;

module.exports = function createWordVec({ dataDir, binUrls = [] }) {
  const file = path.join(dataDir || '.', 'wordvec-ko.bin');
  let words = null; let index = null; let scale = null; let vec = null;
  let state = 'idle'; let note = ''; let loading = null;

  function setData(w, sc, v) {
    words = w; scale = sc; vec = v;
    index = new Map(); w.forEach((x, i) => index.set(x, i));
    state = 'ready'; note = `${w.length.toLocaleString()}개 단어`;
  }
  // 파일 모양: WV01 · 단어 수(u32) · 차원(u32) · 단어 JSON 길이(u32) · 단어 JSON · 단어별 배율(float32) · 벡터(int8)
  function encode(w, sc, v) {
    const wj = Buffer.from(JSON.stringify(w), 'utf8');
    const head = Buffer.alloc(16); head.write(MAGIC, 0, 'ascii'); head.writeUInt32LE(w.length, 4); head.writeUInt32LE(DIM, 8); head.writeUInt32LE(wj.length, 12);
    return Buffer.concat([head, wj, Buffer.from(sc.buffer, sc.byteOffset, sc.byteLength), Buffer.from(v.buffer, v.byteOffset, v.byteLength)]);
  }
  function decode(buf) {
    if (buf.length < 16 || buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('파일 모양이 달라요');
    const n = buf.readUInt32LE(4); const dim = buf.readUInt32LE(8); const wl = buf.readUInt32LE(12);
    if (dim !== DIM || !n) throw new Error('차원이 달라요');
    const w = JSON.parse(buf.toString('utf8', 16, 16 + wl));
    let o = 16 + wl;
    const sc = new Float32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + n * 4)); o += n * 4;
    const v = new Int8Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + n * DIM));
    if (w.length !== n || v.length !== n * DIM) throw new Error('파일이 잘렸어요');
    return [w, sc, v];
  }

  // fastText .vec.gz 를 흘려 받으면서 한글 단어만 골라요 (다 받기 전에 끊어요)
  async function fromFastText() {
    note = '단어 사전 받는 중 (처음 한 번만 · 몇 분 걸려요)';
    const r = await fetch(FT_URL, { signal: AbortSignal.timeout(30 * 60e3) });
    if (!r.ok || !r.body) throw new Error('단어 사전 응답 ' + r.status);
    const gz = Readable.fromWeb(r.body).pipe(zlib.createGunzip());
    const w = []; const sc = new Float32Array(KEEP); const v = new Int8Array(KEEP * DIM);
    let lines = 0; let rest = ''; const seen = new Set();
    const tmp = new Float32Array(DIM);
    await new Promise((resolve, reject) => {
      let done = false;
      const stop = () => { if (done) return; done = true; try { gz.destroy(); } catch (_) {} resolve(); };
      gz.on('data', (chunk) => {
        if (done) return;
        const parts = (rest + chunk.toString('utf8')).split('\n'); rest = parts.pop();
        for (const ln of parts) {
          if (++lines === 1) continue; // 첫 줄은 "단어수 차원"
          if (lines > MAX_LINES || w.length >= KEEP) return stop();
          const sp = ln.indexOf(' '); if (sp < 1) continue;
          const t = ln.slice(0, sp);
          if (!WORD_RE.test(t) || seen.has(t)) continue;
          const nums = ln.slice(sp + 1).trim().split(' ');
          if (nums.length !== DIM) continue;
          let nn = 0; for (let i = 0; i < DIM; i++) { const x = Number(nums[i]) || 0; tmp[i] = x; nn += x * x; }
          nn = Math.sqrt(nn) || 1;
          let mx = 0; for (let i = 0; i < DIM; i++) { tmp[i] /= nn; const a = Math.abs(tmp[i]); if (a > mx) mx = a; }
          const k = w.length; const s = (mx || 1) / 127;
          for (let i = 0; i < DIM; i++) v[k * DIM + i] = Math.round(tmp[i] / s);
          sc[k] = s; w.push(t); seen.add(t);
        }
        if (w.length % 5000 === 0) note = `단어 사전 받는 중 (${w.length.toLocaleString()}/${KEEP.toLocaleString()})`;
      });
      gz.on('end', stop);
      gz.on('error', (e) => (done ? resolve() : reject(e)));
    });
    if (w.length < 1000) throw new Error('단어를 거의 못 받았어요');
    return [w, sc.slice(0, w.length), v.slice(0, w.length * DIM)];
  }
  async function fromBin(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(5 * 60e3) });
    if (!r.ok) throw new Error('응답 ' + r.status);
    return decode(Buffer.from(await r.arrayBuffer()));
  }

  function ensure() {
    if (state === 'ready') return Promise.resolve(true);
    if (loading) return loading;
    state = 'loading'; note = '단어 사전 여는 중';
    loading = (async () => {
      try {
        try { const [w, sc, v] = decode(fs.readFileSync(file)); setData(w, sc, v); return true; } catch (_) {}
        let got = null;
        for (const u of binUrls.filter(Boolean)) { try { note = '단어 사전 받는 중'; got = await fromBin(u); break; } catch (e) { console.log('[단어 맞추기] 사전 파일 못 받음', u, e.message); } }
        if (!got) got = await fromFastText();
        setData(...got);
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', encode(...got)); fs.renameSync(file + '.tmp', file); } catch (e) { console.log('[단어 맞추기] 사전 저장 실패', e.message); }
        console.log('[단어 맞추기] 단어 사전 준비 완료', note);
        return true;
      } catch (e) {
        state = 'error'; note = '단어 사전을 못 받았어요: ' + e.message;
        console.log('[단어 맞추기]', note);
        return false;
      } finally { loading = null; }
    })();
    return loading;
  }

  const has = (w) => state === 'ready' && index.has(w);
  function dot(a, b) {
    let s = 0; const ao = a * DIM; const bo = b * DIM;
    for (let i = 0; i < DIM; i++) s += vec[ao + i] * vec[bo + i];
    return s * scale[a] * scale[b];
  }
  // 정답 단어 기준으로 모든 단어와의 유사도 (게임 시작할 때 한 번)
  function board(target) {
    const t = index.get(target); if (t === undefined) return null;
    const n = words.length; const sims = new Float32Array(n);
    for (let i = 0; i < n; i++) sims[i] = i === t ? -2 : dot(t, i);
    const sorted = Array.from(sims).filter((x) => x > -2).sort((a, b) => b - a);
    return {
      t, sims,
      top: (k) => sorted[Math.min(sorted.length - 1, k - 1)] || 0,
      sim: (w) => { const i = index.get(w); return i === undefined ? null : (i === t ? 1 : sims[i]); },
      rank: (s) => { let lo = 0; let hi = Math.min(sorted.length, 1000); while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] > s) lo = m + 1; else hi = m; } return lo < 1000 ? lo + 1 : 0; }, // 0 = 1000위 밖
    };
  }
  const status = () => ({ state, note, words: words ? words.length : 0 });
  const filePath = () => (state === 'ready' && fs.existsSync(file) ? file : '');
  return { ensure, has, board, status, filePath };
};
