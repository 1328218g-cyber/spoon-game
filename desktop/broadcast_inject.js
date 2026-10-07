// broadcast_inject.js — 🎙️ 에디냥 방송하기: 스푼 창(스푼 웹)에 넣는 고음질 사운드 엔진 (v2)
//  · 스푼 웹이 방송을 켤 때 마이크를 달라고 하면(getUserMedia) → 에디냥이 만든 소리를 대신 줘요
//  · 목소리: 마이크(원음·48kHz) [+ 게스트 마이크] → 저음 웅웅 제거 → 노이즈 게이트 → 치찰음 줄이기 → EQ → 컴프레서
//            → 보이스 체인저(음높이/로봇) → 리버브 · 에코 · 코러스
//  · 음악: 배경음악(크로스페이드·페이드·보컬 제거) + PC 소리 → 덕킹(말하면 자동으로 줄이기)
//  · 효과음 패드 · 봇 소리(스푼 음향/TTS 등)는 그대로 섞음 → 출력 → 리미터 → 방송 / 녹음 / 모니터
//  · 방송 연결(WebRTC)은 스푼 웹이 하던 그대로 — 전송 설정만 스테레오·고비트레이트로 올려요
//  · 봇 창에서 window.__ediAudio.xxx() 로 조절 (메인 프로세스가 executeJavaScript 로 호출)
(function () {
  if (window.__ediAudio) return;
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;

  const S = {
    enabled: true, deviceId: '', inGain: 1.0, micMute: false, nsOn: false,
    mic2On: false, mic2Id: '', mic2Vol: 1.0,
    hpfOn: true, hpfFreq: 80,
    gateOn: false, gateDb: -50,
    deessOn: false, deessAmt: 6,
    eqLow: 0, eqMid: 0, eqHigh: 0,
    compOn: true, compThr: -20, compRatio: 3,
    limOn: true,
    revOn: true, revMix: 0.18, revSize: 1.8, revPre: 0.02,
    echoOn: false, echoTime: 0.28, echoFb: 0.3, echoMix: 0.15,
    chorusOn: false, chorusMix: 0.35,
    vcMode: 'off', vcPitch: 0.4,
    outGain: 1.0, monitor: false, monitorVol: 0.8,
    bitrate: 256, stereo: true,
    bgmVol: 0.5, karaoke: false,
    duckOn: false, duckAmt: 12, duckThr: -42,
    padVol: 0.8, botVol: 0.9,
    pcOn: false, pcVol: 0.8,
  };
  const origGUM = md.getUserMedia.bind(md);
  const origGDM = md.getDisplayMedia ? md.getDisplayMedia.bind(md) : null;
  let ctx = null, G = null, dest = null, outTrack = null, active = false, testing = false;
  const mic = { s: null, src: null, key: '' }, mic2 = { s: null, src: null, key: '' };
  const pc = { stream: null, src: null };
  let loopTimer = null, irTimer = null, lastIrSize = 0;
  const bgm = { cur: null, url: '', fadingOut: false };
  const rec = { mr: null, dest: null, id: 0, since: 0 };
  let ipc = null;
  try { ipc = window.require ? window.require('electron').ipcRenderer : null; } catch (_) { ipc = null; }

  const db2lin = (d) => Math.pow(10, d / 20);
  const T = () => ctx.currentTime;
  function setP(param, v, tc = 0.02) { try { param.setTargetAtTime(v, T(), tc); } catch (_) { try { param.value = v; } catch (__) {} } }
  function rmsDb(an, buf) { an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return 10 * Math.log10(s / buf.length + 1e-12); }

  function irBuffer(sec) {
    const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * sec));
    const b = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    return b;
  }

  // 🎭 음높이 바꾸기 (딜레이 두 줄을 번갈아 쓰는 방식 — 추가 파일 없이 동작)
  function createPitchShifter() {
    const sr = ctx.sampleRate, bufferTime = 0.1, fadeTime = 0.05, delayTime = 0.1;
    const l1 = Math.floor(bufferTime * sr), l2 = Math.floor((bufferTime - 2 * fadeTime) * sr), len = l1 + l2;
    const fadeBuf = (() => {
      const b = ctx.createBuffer(1, len, sr), p = b.getChannelData(0), fl = fadeTime * sr, i1 = fl, i2 = l1 - fl;
      for (let i = 0; i < l1; i++) p[i] = i < i1 ? Math.sqrt(i / fl) : (i >= i2 ? Math.sqrt(1 - (i - i2) / fl) : 1);
      return b;
    })();
    const delayBuf = (up) => {
      const b = ctx.createBuffer(1, len, sr), p = b.getChannelData(0);
      for (let i = 0; i < l1; i++) p[i] = up ? (l1 - i) / len : i / l1;
      return b;
    };
    const src = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; return s; };
    const input = ctx.createGain(), output = ctx.createGain();
    const mod1 = src(delayBuf(false)), mod2 = src(delayBuf(false)), mod3 = src(delayBuf(true)), mod4 = src(delayBuf(true));
    const m1 = ctx.createGain(), m2 = ctx.createGain(), m3 = ctx.createGain(), m4 = ctx.createGain();
    m3.gain.value = 0; m4.gain.value = 0;
    mod1.connect(m1); mod2.connect(m2); mod3.connect(m3); mod4.connect(m4);
    const mg1 = ctx.createGain(), mg2 = ctx.createGain();
    const d1 = ctx.createDelay(), d2 = ctx.createDelay();
    m1.connect(mg1); m2.connect(mg2); m3.connect(mg1); m4.connect(mg2);
    mg1.connect(d1.delayTime); mg2.connect(d2.delayTime);
    const f1 = src(fadeBuf), f2 = src(fadeBuf), mix1 = ctx.createGain(), mix2 = ctx.createGain();
    mix1.gain.value = 0; mix2.gain.value = 0;
    f1.connect(mix1.gain); f2.connect(mix2.gain);
    input.connect(d1); input.connect(d2); d1.connect(mix1); d2.connect(mix2); mix1.connect(output); mix2.connect(output);
    const t = T() + 0.05, t2 = t + bufferTime - fadeTime;
    mod1.start(t); mod2.start(t2); mod3.start(t); mod4.start(t2); f1.start(t); f2.start(t2);
    return {
      input, output,
      set(mult) {
        const up = mult > 0;
        setP(m1.gain, up ? 0 : 1, 0.01); setP(m2.gain, up ? 0 : 1, 0.01); setP(m3.gain, up ? 1 : 0, 0.01); setP(m4.gain, up ? 1 : 0, 0.01);
        const dt = 0.5 * delayTime * Math.min(1, Math.abs(mult));
        setP(mg1.gain, dt, 0.01); setP(mg2.gain, dt, 0.01);
      },
    };
  }

  function ensureGraph() {
    if (G) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
    const g = {};
    const gain = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q) n.Q.value = q; return n; };
    const an = () => { const n = ctx.createAnalyser(); n.fftSize = 1024; return n; };
    // 🎤 목소리
    g.m1 = gain(); g.m2 = gain(0); g.vIn = gain();
    g.m1.connect(g.vIn); g.m2.connect(g.vIn);
    g.hpf = bq('highpass', 80, 0.7);
    g.gate = gain(); g.anGate = an();
    g.deessBand = bq('bandpass', 7000, 1.0); g.anDeess = an();
    g.deess = bq('peaking', 7000, 1.4);
    g.eqLow = bq('lowshelf', 120); g.eqMid = bq('peaking', 1500, 0.9); g.eqHigh = bq('highshelf', 6000);
    g.comp = ctx.createDynamicsCompressor(); g.comp.attack.value = 0.005; g.comp.release.value = 0.18; g.comp.knee.value = 6;
    g.makeup = gain();
    g.anVoice = an();
    g.vIn.connect(g.hpf); g.hpf.connect(g.anGate); g.hpf.connect(g.gate);
    g.hpf.connect(g.deessBand); g.deessBand.connect(g.anDeess);
    g.gate.connect(g.deess); g.deess.connect(g.eqLow); g.eqLow.connect(g.eqMid); g.eqMid.connect(g.eqHigh); g.eqHigh.connect(g.comp); g.comp.connect(g.makeup);
    g.makeup.connect(g.anVoice);
    // 🎭 보이스 체인저: 음높이 → 로봇
    g.pitchIn = gain(); g.pitchDry = gain(1); g.pitchWet = gain(0); g.pitchOut = gain();
    g.pitch = createPitchShifter();
    g.makeup.connect(g.pitchIn); g.pitchIn.connect(g.pitchDry); g.pitchDry.connect(g.pitchOut);
    g.pitchIn.connect(g.pitch.input); g.pitch.output.connect(g.pitchWet); g.pitchWet.connect(g.pitchOut);
    g.robotDry = gain(1); g.robotWet = gain(0); g.ring = gain(0); g.vPost = gain();
    g.robotOsc = ctx.createOscillator(); g.robotOsc.frequency.value = 45; g.robotOsc.connect(g.ring.gain); g.robotOsc.start();
    g.pitchOut.connect(g.robotDry); g.robotDry.connect(g.vPost);
    g.pitchOut.connect(g.ring); g.ring.connect(g.robotWet); g.robotWet.connect(g.vPost);
    // 공간 효과
    g.voiceBus = gain();
    g.vPost.connect(g.voiceBus);
    g.revSend = gain(); g.preDelay = ctx.createDelay(1.0); g.conv = ctx.createConvolver(); g.revWet = gain();
    g.vPost.connect(g.revSend); g.revSend.connect(g.preDelay); g.preDelay.connect(g.conv); g.conv.connect(g.revWet); g.revWet.connect(g.voiceBus);
    g.echoSend = gain(); g.echoDelay = ctx.createDelay(2.0); g.echoFb = gain(); g.echoWet = gain();
    g.vPost.connect(g.echoSend); g.echoSend.connect(g.echoDelay); g.echoDelay.connect(g.echoFb); g.echoFb.connect(g.echoDelay); g.echoDelay.connect(g.echoWet); g.echoWet.connect(g.voiceBus);
    g.chSend = gain(); g.chWet = gain(0);
    const voice = (base, rate, panV) => {
      const d = ctx.createDelay(0.1); d.delayTime.value = base;
      const lfo = ctx.createOscillator(); lfo.frequency.value = rate; const depth = gain(0.003); lfo.connect(depth); depth.connect(d.delayTime); lfo.start();
      const p = ctx.createStereoPanner(); p.pan.value = panV;
      g.chSend.connect(d); d.connect(p); p.connect(g.chWet);
    };
    voice(0.019, 0.31, -0.7); voice(0.027, 0.43, 0.7);
    g.vPost.connect(g.chSend); g.chWet.connect(g.voiceBus);
    // 🎵 음악: 배경음악(보컬 제거 선택) + PC 소리 → 덕킹
    g.bgmPre = gain();
    g.kNorm = gain(1); g.kOn = gain(0);
    const sp = ctx.createChannelSplitter(2), kl = gain(1), kr = gain(-1), ksum = gain(1), mg = ctx.createChannelMerger(2);
    g.bgmPre.connect(g.kNorm); g.bgmPre.connect(sp); sp.connect(kl, 0); sp.connect(kr, 1); kl.connect(ksum); kr.connect(ksum);
    ksum.connect(mg, 0, 0); ksum.connect(mg, 0, 1); mg.connect(g.kOn);
    g.bgmGain = gain(); g.kNorm.connect(g.bgmGain); g.kOn.connect(g.bgmGain);
    g.pcGain = gain();
    g.musicBus = gain(); g.duck = gain();
    g.bgmGain.connect(g.musicBus); g.pcGain.connect(g.musicBus); g.musicBus.connect(g.duck);
    // 🔔 효과음 · 봇 소리
    g.padGain = gain(); g.botGain = gain();
    // 출력
    g.mix = gain();
    g.voiceBus.connect(g.mix); g.duck.connect(g.mix); g.padGain.connect(g.mix); g.botGain.connect(g.mix);
    g.out = gain();
    g.lim = ctx.createDynamicsCompressor(); g.lim.knee.value = 0; g.lim.attack.value = 0.002; g.lim.release.value = 0.12;
    g.anOut = an(); g.monitor = gain(0);
    g.mix.connect(g.out); g.out.connect(g.lim); g.lim.connect(g.anOut); g.lim.connect(g.monitor); g.monitor.connect(ctx.destination);
    G = g;
    apply();
    startLoop();
  }

  // ⏱️ 게이트 · 치찰음 · 덕킹 — 소리 크기를 보고 실시간으로 조절
  function startLoop() {
    const b1 = new Float32Array(1024), b2 = new Float32Array(1024), b3 = new Float32Array(1024);
    let duckHold = 0;
    loopTimer = setInterval(() => {
      if (!G) return;
      if (S.gateOn) { const open = rmsDb(G.anGate, b1) > S.gateDb; try { G.gate.gain.setTargetAtTime(open ? 1 : 0, T(), open ? 0.005 : 0.08); } catch (_) {} }
      else setP(G.gate.gain, 1);
      if (S.deessOn) { const hot = rmsDb(G.anDeess, b2) > -38; try { G.deess.gain.setTargetAtTime(hot ? -S.deessAmt : 0, T(), hot ? 0.003 : 0.05); } catch (_) {} }
      else setP(G.deess.gain, 0);
      if (S.duckOn) {
        const talking = !S.micMute && rmsDb(G.anVoice, b3) > S.duckThr;
        if (talking) duckHold = Date.now() + 350;
        const down = Date.now() < duckHold;
        try { G.duck.gain.setTargetAtTime(down ? db2lin(-S.duckAmt) : 1, T(), down ? 0.04 : 0.35); } catch (_) {}
      } else setP(G.duck.gain, 1);
    }, 15);
  }

  function apply() {
    if (!G) return;
    setP(G.m1.gain, S.micMute ? 0 : S.inGain); // 🔇 마이크 끄기 — 음악·효과음·PC 소리는 그대로
    setP(G.m2.gain, S.mic2On && !S.micMute ? S.mic2Vol : 0);
    setP(G.hpf.frequency, S.hpfOn ? Math.max(20, Math.min(300, S.hpfFreq)) : 10);
    setP(G.eqLow.gain, S.eqLow); setP(G.eqMid.gain, S.eqMid); setP(G.eqHigh.gain, S.eqHigh);
    if (S.compOn) {
      setP(G.comp.threshold, S.compThr); setP(G.comp.ratio, S.compRatio);
      setP(G.makeup.gain, db2lin(Math.min(12, Math.max(0, (-S.compThr) * (1 - 1 / S.compRatio) * 0.4))));
    } else { setP(G.comp.threshold, 0); setP(G.comp.ratio, 1); setP(G.makeup.gain, 1); }
    // 🎭 보이스 체인저
    const pitchOn = S.vcMode === 'pitch', robotOn = S.vcMode === 'robot';
    setP(G.pitchDry.gain, pitchOn ? 0 : 1); setP(G.pitchWet.gain, pitchOn ? 1 : 0);
    G.pitch.set(pitchOn ? (S.vcPitch || 0.0001) : 0.0001);
    setP(G.robotDry.gain, robotOn ? 0 : 1); setP(G.robotWet.gain, robotOn ? 1.6 : 0);
    // 공간
    setP(G.revSend.gain, S.revOn ? 1 : 0); setP(G.revWet.gain, S.revOn ? S.revMix : 0);
    setP(G.preDelay.delayTime, Math.max(0, Math.min(0.2, S.revPre)));
    setP(G.echoSend.gain, S.echoOn ? 1 : 0); setP(G.echoWet.gain, S.echoOn ? S.echoMix : 0);
    setP(G.echoDelay.delayTime, Math.max(0.05, Math.min(1.5, S.echoTime))); setP(G.echoFb.gain, Math.max(0, Math.min(0.85, S.echoFb)));
    setP(G.chSend.gain, S.chorusOn ? 1 : 0); setP(G.chWet.gain, S.chorusOn ? S.chorusMix : 0);
    // 음악 · 효과음
    setP(G.bgmGain.gain, S.bgmVol); setP(G.kNorm.gain, S.karaoke ? 0 : 1); setP(G.kOn.gain, S.karaoke ? 1 : 0);
    setP(G.pcGain.gain, S.pcVol); setP(G.padGain.gain, S.padVol); setP(G.botGain.gain, S.botVol);
    // 출력 · 리미터
    setP(G.out.gain, S.outGain);
    if (S.limOn) { setP(G.lim.threshold, -1.5); setP(G.lim.ratio, 20); } else { setP(G.lim.threshold, 0); setP(G.lim.ratio, 1); }
    // PC 소리를 같이 내보낼 땐 모니터를 꺼요 — 모니터 소리가 다시 PC 소리로 잡혀서 메아리처럼 돌아요
    setP(G.monitor.gain, S.monitor && !S.pcOn ? S.monitorVol : 0);
    if (Math.abs(lastIrSize - S.revSize) > 0.01) {
      clearTimeout(irTimer);
      irTimer = setTimeout(() => { lastIrSize = S.revSize; try { G.conv.buffer = irBuffer(Math.max(0.2, Math.min(6, S.revSize))); } catch (_) {} }, lastIrSize ? 250 : 0);
    }
  }

  // 🎤 마이크 열기 (통화용 처리 끔 · 잡음 제거는 선택)
  async function openOne(slot, devId, node) {
    const key = devId + '|' + (S.nsOn ? 1 : 0);
    if (slot.s && slot.key === key) return;
    closeOne(slot);
    slot.s = await origGUM({
      audio: {
        deviceId: devId ? { exact: devId } : undefined,
        echoCancellation: false, noiseSuppression: !!S.nsOn, autoGainControl: false,
        channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 }, sampleSize: { ideal: 24 },
      },
      video: false,
    });
    slot.key = key;
    slot.src = ctx.createMediaStreamSource(slot.s); slot.src.connect(node);
  }
  function closeOne(slot) {
    try { if (slot.src) slot.src.disconnect(); } catch (_) {}
    if (slot.s) slot.s.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    slot.s = null; slot.src = null; slot.key = '';
  }
  async function openMics() {
    ensureGraph();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
    await openOne(mic, S.deviceId, G.m1);
    if (S.mic2On) { try { await openOne(mic2, S.mic2Id, G.m2); } catch (_) {} } else closeOne(mic2);
  }
  // 방송 · 내 소리 듣기 · 녹음 중 하나라도 쓰면 마이크를 열어둬요
  function micNeeded() { return active || testing || !!rec.mr; }
  function maybeCloseMics() { if (!micNeeded()) { closeOne(mic); closeOne(mic2); } }

  // 🎙️ 스푼 웹이 마이크를 달라고 할 때 → 에디냥 소리를 줘요
  md.getUserMedia = async function (c) {
    if (!S.enabled || !c || !c.audio || c.video) return origGUM(c);
    active = true;
    try { await openMics(); } catch (e) { active = false; throw e; }
    try { if (dest) G.lim.disconnect(dest); } catch (_) {}
    dest = ctx.createMediaStreamDestination(); dest.channelCount = 2;
    G.lim.connect(dest);
    outTrack = dest.stream.getAudioTracks()[0];
    const stop0 = outTrack.stop.bind(outTrack);
    outTrack.stop = () => { stop0(); active = false; maybeCloseMics(); badge(); };
    badge();
    return new MediaStream([outTrack]);
  };

  // 📡 전송 설정 — Opus 스테레오 + 높은 비트레이트
  function mungeSdp(sdp) {
    if (!active || !sdp) return sdp;
    const m = sdp.match(/a=rtpmap:(\d+) opus\/48000(?:\/2)?/i);
    if (!m) return sdp;
    const pt = m[1];
    const extra = { maxaveragebitrate: S.bitrate * 1000, maxplaybackrate: 48000, useinbandfec: 1, usedtx: 0 };
    if (S.stereo) { extra.stereo = 1; extra['sprop-stereo'] = 1; }
    const re = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
    const fmt = (kv) => 'a=fmtp:' + pt + ' ' + Object.entries(kv).map(([k, v]) => (v === undefined ? k : k + '=' + v)).join(';');
    if (re.test(sdp)) {
      return sdp.replace(re, (all, params) => {
        const kv = {};
        params.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) kv[p.slice(0, i).trim()] = p.slice(i + 1).trim(); else if (p.trim()) kv[p.trim()] = undefined; });
        return fmt(Object.assign(kv, extra));
      });
    }
    return sdp.replace(m[0], m[0] + '\r\n' + fmt(extra));
  }
  const PC = window.RTCPeerConnection;
  if (PC && PC.prototype) {
    const sld = PC.prototype.setLocalDescription, srd = PC.prototype.setRemoteDescription;
    const fix = (d) => (d && d.sdp ? { type: d.type, sdp: mungeSdp(d.sdp) } : d);
    PC.prototype.setLocalDescription = function (d, ...rest) { return sld.call(this, fix(d), ...rest); };
    PC.prototype.setRemoteDescription = function (d, ...rest) {
      const pcn = this;
      const r = srd.call(this, fix(d), ...rest);
      Promise.resolve(r).then(() => boostSenders(pcn)).catch(() => {});
      return r;
    };
  }
  function boostSenders(pcn) {
    if (!active) return;
    try {
      pcn.getSenders().forEach((s) => {
        if (!s.track || s.track.kind !== 'audio' || !s.getParameters) return;
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = S.bitrate * 1000;
        p.encodings[0].priority = 'high';
        s.setParameters(p).catch(() => {});
      });
    } catch (_) {}
  }

  // 🎵 배경음악 — 크로스페이드 · 페이드 인/아웃
  async function ready() { ensureGraph(); if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} } }
  function mediaEl(url, node) {
    const el = new Audio(); el.crossOrigin = 'anonymous'; el.src = url; el.preload = 'auto';
    const src = ctx.createMediaElementSource(el); const g = ctx.createGain(); src.connect(g); g.connect(node);
    return { el, src, g };
  }
  function dropTrack(t, fade) {
    if (!t) return;
    const end = () => { try { t.el.pause(); t.src.disconnect(); t.g.disconnect(); } catch (_) {} };
    if (fade > 0) { try { t.g.gain.cancelScheduledValues(T()); t.g.gain.setValueAtTime(t.g.gain.value, T()); t.g.gain.linearRampToValueAtTime(0, T() + fade); } catch (_) {} setTimeout(end, fade * 1000 + 80); }
    else end();
  }
  async function playBgm(o) {
    await ready();
    const fade = Math.max(0, Math.min(10, Number(o.fade) || 0));
    const old = bgm.cur;
    const t = mediaEl(o.url, G.bgmPre);
    t.el.loop = !!o.loop;
    if (old && fade > 0 && !old.el.paused) { t.g.gain.setValueAtTime(0, T()); t.g.gain.linearRampToValueAtTime(1, T() + fade); dropTrack(old, fade); }
    else { dropTrack(old, 0); }
    bgm.cur = t; bgm.url = o.url; bgm.fadingOut = false;
    await t.el.play();
    return true;
  }
  function stopBgm(o) { dropTrack(bgm.cur, o && o.fade ? Math.min(10, +o.fade) : 0); bgm.cur = null; bgm.url = ''; return true; }
  function bgmPause() { const t = bgm.cur; if (!t) return false; if (t.el.paused) { bgm.fadingOut = false; t.g.gain.cancelScheduledValues(T()); t.g.gain.setValueAtTime(1, T()); t.el.play(); } else t.el.pause(); return !t.el.paused; }
  // 부드럽게 끄기/켜기 (F10) — 끌 땐 줄어든 뒤 멈추고, 켤 땐 이어서 0 → 원래 크기
  async function bgmFade(o) {
    const t = bgm.cur; if (!t) return { playing: false };
    await ready();
    const secs = Math.max(0.3, Math.min(10, Number(o && o.secs) || 2));
    const gp = t.g.gain;
    gp.cancelScheduledValues(T()); gp.setValueAtTime(gp.value, T());
    if (!t.el.paused && !bgm.fadingOut) {
      bgm.fadingOut = true; gp.linearRampToValueAtTime(0, T() + secs);
      setTimeout(() => { if (bgm.cur === t && bgm.fadingOut) t.el.pause(); }, secs * 1000 + 50);
      return { playing: false };
    }
    bgm.fadingOut = false; gp.setValueAtTime(0, T()); gp.linearRampToValueAtTime(1, T() + secs);
    try { await t.el.play(); } catch (_) {}
    return { playing: true };
  }
  // 🔔 효과음 · 봇 소리 (한 번 재생)
  async function playSfx(o) {
    await ready();
    const t = mediaEl(o.url, o.bus === 'bot' ? G.botGain : G.padGain);
    t.g.gain.value = Math.max(0, Math.min(2, o.vol == null ? 1 : +o.vol));
    t.el.onended = () => { try { t.src.disconnect(); t.g.disconnect(); } catch (_) {} };
    await t.el.play();
    return true;
  }

  // 🔊 PC 소리 같이 내보내기 — 유튜브·멜론 등 PC 에서 나는 소리를 마이크 없이 바로 섞어요 (윈도우)
  async function startPc() {
    await ready();
    if (pc.stream) return true;
    if (!origGDM) throw new Error('이 PC 에서는 PC 소리 잡기를 쓸 수 없어요');
    const s = await origGDM({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    s.getVideoTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    const at = s.getAudioTracks();
    if (!at.length) throw new Error('PC 소리를 못 잡았어요 (윈도우에서만 돼요)');
    pc.stream = new MediaStream(at);
    pc.src = ctx.createMediaStreamSource(pc.stream); pc.src.connect(G.pcGain);
    at[0].onended = () => { stopPc(); S.pcOn = false; apply(); };
    return true;
  }
  function stopPc() {
    try { if (pc.src) pc.src.disconnect(); } catch (_) {}
    if (pc.stream) pc.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    pc.stream = null; pc.src = null;
  }

  // ⏺️ 방송 녹음 — 방송으로 나가는 소리 그대로 (5초마다 조각을 메인으로 보내 파일로 저장)
  async function recStart() {
    if (rec.mr) return { on: true, since: rec.since };
    if (!ipc) throw new Error('녹음을 쓸 수 없는 창이에요');
    await openMics();
    rec.dest = ctx.createMediaStreamDestination(); rec.dest.channelCount = 2; G.lim.connect(rec.dest);
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const mr = new MediaRecorder(rec.dest.stream, { mimeType: mime, audioBitsPerSecond: 192000 });
    const id = Date.now(); rec.id = id; rec.since = id; rec.mr = mr;
    ipc.send('bcast:rec', { op: 'start', id });
    let pending = Promise.resolve();
    mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      pending = pending.then(async () => { try { ipc.send('bcast:rec', { op: 'chunk', id, buf: new Uint8Array(await e.data.arrayBuffer()) }); } catch (_) {} });
    };
    const d = rec.dest;
    mr.onstop = () => { pending.then(() => ipc.send('bcast:rec', { op: 'end', id })); try { G.lim.disconnect(d); } catch (_) {} };
    mr.start(5000);
    return { on: true, since: rec.since };
  }
  function recStop() { if (rec.mr) { try { rec.mr.stop(); } catch (_) {} } rec.mr = null; rec.since = 0; rec.dest = null; maybeCloseMics(); return { on: false }; }

  // 🔴 창에 상태 표시
  function badge() {
    try {
      let b = document.getElementById('__ediAudioBadge');
      if (!active && !rec.mr) { if (b) b.remove(); return; }
      if (!b) {
        b = document.createElement('div'); b.id = '__ediAudioBadge';
        b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;color:#fff;font:700 12px/1 sans-serif;padding:8px 12px;border-radius:99px;box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none';
        document.body.appendChild(b);
      }
      b.textContent = (S.micMute ? '🔇 마이크 꺼짐 (음악은 나가요)' : '🎙️ 에디냥 사운드 적용 중') + (rec.mr ? ' · ⏺ 녹음 중' : '');
      b.style.background = S.micMute ? '#dc2626' : '#6d4fd6';
    } catch (_) {}
  }

  function peakDb(an) {
    if (!an) return -100;
    const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
    let pk = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; }
    return pk > 0 ? Math.max(-100, 20 * Math.log10(pk)) : -100;
  }
  function bgmInfo() {
    const t = bgm.cur; if (!t) return { playing: false };
    return { playing: !t.el.paused, cur: t.el.currentTime || 0, dur: isFinite(t.el.duration) ? t.el.duration : 0, ended: !!t.el.ended, url: bgm.url };
  }

  window.__ediAudio = {
    version: 2,
    get: () => ({ ...S }),
    set: async (p) => {
      const prev = { ...S };
      Object.assign(S, p || {}); if (G) apply(); badge();
      const micChanged = ['deviceId', 'nsOn', 'mic2On', 'mic2Id'].some((k) => p && k in p && p[k] !== prev[k]);
      if (micChanged && micNeeded()) openMics().catch(() => {});
      if (p && 'pcOn' in p) {
        if (S.pcOn) { try { await startPc(); apply(); } catch (e) { S.pcOn = false; if (G) apply(); return { ...S, __pcErr: e.message || String(e) }; } }
        else stopPc();
      }
      return { ...S };
    },
    status: () => ({ active, ctx: ctx ? ctx.state : 'none', bgm: bgmInfo(), pc: !!pc.stream, rec: rec.mr ? { on: true, since: rec.since } : { on: false }, testing }),
    levels: () => ({ mic: G ? peakDb(G.anGate) : -100, out: G ? peakDb(G.anOut) : -100, active, pc: !!pc.stream, bgm: bgmInfo(), rec: !!rec.mr }),
    devices: async () => {
      try {
        let list = await md.enumerateDevices();
        if (!list.some((d) => d.kind === 'audioinput' && d.label)) { const s = await origGUM({ audio: true }); s.getTracks().forEach((t) => t.stop()); list = await md.enumerateDevices(); }
        return list.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || '마이크' }));
      } catch (e) { return []; }
    },
    // 방송 전에 내 소리 들어보기 (헤드폰으로!)
    test: async (on) => { testing = !!on; if (on) { await openMics(); S.monitor = true; } else { S.monitor = false; maybeCloseMics(); } apply(); return true; },
    playBgm, stopBgm, bgmPause, bgmFade, playSfx,
    playPad: (o) => playSfx({ ...(o || {}), bus: 'pad' }),
    recStart: async () => { const r = await recStart(); badge(); return r; },
    recStop: () => { const r = recStop(); badge(); return r; },
  };
})();
