// broadcast_inject.js — 🎙️ 에디냥 방송하기: 스푼 창(스푼 웹)에 넣는 고음질 사운드 엔진 (v2)
//  · 스푼 웹이 방송을 켤 때 마이크를 달라고 하면(getUserMedia) → 에디냥이 만든 소리를 대신 줘요
//  · 목소리: 마이크(원음·48kHz) [+ 게스트 마이크] → 저음 웅웅 제거 → 노이즈 게이트 → 치찰음 줄이기 → EQ → 컴프레서
//            → 보이스 체인저(음높이/로봇) → 리버브 · 에코 · 코러스
//  · 음악: 배경음악(크로스페이드·페이드·보컬 제거) + PC 소리 → 덕킹(말하면 자동으로 줄이기)
//  · 효과음 패드 · 봇 소리(스푼 음향/TTS 등)는 그대로 섞음 → 출력 → 리미터 → 방송 / 녹음 / 모니터
//  · 곡마다 소리 크기 자동 맞춤 · 배경 환경음(빗소리·파도·모닥불·내 파일) · 인트로(방송 시작)/아웃트로(라이브 종료 전)
//  · 방송 사고 알림: 마이크 꺼진 채 말하기 · 무음 · 소리 찢어짐 → 방송 창 위쪽 + 방송하기 화면에 경고
//  · 방송 연결(WebRTC)은 스푼 웹이 하던 그대로 — 전송 설정만 스테레오·고비트레이트로 올려요
//  · 봇 창에서 window.__ediAudio.xxx() 로 조절 (메인 프로세스가 executeJavaScript 로 호출)
(function () {
  if (window.__ediAudio) return;
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;

  const S = {
    enabled: true, deviceId: '', inGain: 1.0, micMute: false, nsOn: false,
    mic2On: false, mic2Id: '', mic2Vol: 1.0,
    // 👥 게스트 마이크 따로 설정 (mic2Link=true 면 지금처럼 메인 마이크 효과를 같이 받음)
    mic2Link: true, mic2Duck: false,
    g2HpfOn: true, g2GateOn: false, g2GateDb: -50, g2EqLow: 0, g2EqMid: 0, g2EqHigh: 0,
    g2CompOn: true, g2CompThr: -20, g2CompRatio: 3, g2RevOn: false, g2RevMix: 0.18, g2EchoOn: false, g2EchoMix: 0.15,
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
    warnMicOff: true, warnClip: true, warnSilence: true, silenceSec: 30,
    bgmNorm: true, normTarget: -16,
    introOn: false, outroOn: false, introUrl: '', outroUrl: '',
    ambOn: false, ambKind: 'rain', ambVol: 0.3, ambUrl: '',
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
    g.anRaw = an(); // 마이크 원음 (마이크 꺼짐·찢어짐 확인용 — 끄기 전 소리)
    g.m1.connect(g.vIn);
    g.m2Link = gain(1); g.m2Own = gain(0); // 👥 게스트: 메인 효과 같이 받기 ↔ 따로 처리
    g.m2.connect(g.m2Link); g.m2Link.connect(g.vIn); g.m2.connect(g.m2Own);
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
    // 👥 게스트 전용 처리: 웅웅 제거 → 게이트 → 음색 → 컴프레서 → (울림·에코는 양만 따로, 공간은 같이)
    g.hpf2 = bq('highpass', 80, 0.7); g.gate2 = gain(); g.anGate2 = an();
    g.eq2L = bq('lowshelf', 120); g.eq2M = bq('peaking', 1500, 0.9); g.eq2H = bq('highshelf', 6000);
    g.comp2 = ctx.createDynamicsCompressor(); g.comp2.attack.value = 0.005; g.comp2.release.value = 0.18; g.comp2.knee.value = 6;
    g.mk2 = gain(); g.anV2 = an(); g.rev2 = gain(0); g.echo2 = gain(0);
    g.m2Own.connect(g.hpf2); g.hpf2.connect(g.anGate2); g.hpf2.connect(g.gate2);
    g.gate2.connect(g.eq2L); g.eq2L.connect(g.eq2M); g.eq2M.connect(g.eq2H); g.eq2H.connect(g.comp2); g.comp2.connect(g.mk2);
    g.mk2.connect(g.anV2); g.mk2.connect(g.voiceBus);
    g.mk2.connect(g.rev2); g.rev2.connect(g.preDelay); g.mk2.connect(g.echo2); g.echo2.connect(g.echoDelay);
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
    g.bgmNorm = gain(); g.anBgm = an(); // 📏 곡마다 소리 크기 맞추기
    g.bgmPre.connect(g.anBgm); g.bgmPre.connect(g.bgmNorm);
    g.bgmNorm.connect(g.kNorm); g.bgmNorm.connect(sp); sp.connect(kl, 0); sp.connect(kr, 1); kl.connect(ksum); kr.connect(ksum);
    ksum.connect(mg, 0, 0); ksum.connect(mg, 0, 1); mg.connect(g.kOn);
    g.bgmGain = gain(); g.kNorm.connect(g.bgmGain); g.kOn.connect(g.bgmGain);
    g.pcGain = gain();
    g.musicBus = gain(); g.duck = gain();
    g.bgmGain.connect(g.musicBus); g.pcGain.connect(g.musicBus); g.musicBus.connect(g.duck);
    // 🔔 효과음 · 봇 소리
    g.padGain = gain(); g.botGain = gain();
    g.ambGain = gain(0); // 🌧️ 배경 환경음 (덕킹 안 받음)
    // 출력
    g.mix = gain();
    g.voiceBus.connect(g.mix); g.duck.connect(g.mix); g.padGain.connect(g.mix); g.botGain.connect(g.mix); g.ambGain.connect(g.mix);
    g.out = gain();
    g.lim = ctx.createDynamicsCompressor(); g.lim.knee.value = 0; g.lim.attack.value = 0.002; g.lim.release.value = 0.12;
    g.anOut = an(); g.monitor = gain(0);
    g.anPre = an(); // 리미터 들어가기 전 (너무 큰 소리 확인용)
    g.mix.connect(g.out); g.out.connect(g.anPre); g.out.connect(g.lim); g.lim.connect(g.anOut); g.lim.connect(g.monitor); g.monitor.connect(ctx.destination);
    G = g;
    apply();
    startLoop();
    startWatch();
  }

  // ⏱️ 게이트 · 치찰음 · 덕킹 — 소리 크기를 보고 실시간으로 조절
  function startLoop() {
    const b1 = new Float32Array(1024), b2 = new Float32Array(1024), b3 = new Float32Array(1024);
    const b4 = new Float32Array(1024), b5 = new Float32Array(1024);
    let duckHold = 0;
    loopTimer = setInterval(() => {
      if (!G) return;
      if (S.gateOn) { const open = rmsDb(G.anGate, b1) > S.gateDb; try { G.gate.gain.setTargetAtTime(open ? 1 : 0, T(), open ? 0.005 : 0.08); } catch (_) {} }
      else setP(G.gate.gain, 1);
      if (S.deessOn) { const hot = rmsDb(G.anDeess, b2) > -38; try { G.deess.gain.setTargetAtTime(hot ? -S.deessAmt : 0, T(), hot ? 0.003 : 0.05); } catch (_) {} }
      else setP(G.deess.gain, 0);
      const own2 = S.mic2On && !S.mic2Link;
      if (own2 && S.g2GateOn) { const open = rmsDb(G.anGate2, b4) > S.g2GateDb; try { G.gate2.gain.setTargetAtTime(open ? 1 : 0, T(), open ? 0.005 : 0.08); } catch (_) {} }
      else setP(G.gate2.gain, 1);
      // 🦆 덕킹: 메인은 덕킹 켜짐일 때 · 게스트는 따로 설정이면 "게스트 말할 때도 줄이기"로 따로 정해요
      const guestDuck = S.mic2On && (S.mic2Link ? S.duckOn : S.mic2Duck);
      if (S.duckOn || guestDuck) {
        const talking = !S.micMute && ((S.duckOn && rmsDb(G.anVoice, b3) > S.duckThr) || (guestDuck && !S.mic2Link && rmsDb(G.anV2, b5) > S.duckThr));
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
    const link2 = S.mic2Link !== false;
    setP(G.m2Link.gain, link2 ? 1 : 0); setP(G.m2Own.gain, link2 ? 0 : 1);
    setP(G.hpf2.frequency, S.g2HpfOn ? Math.max(20, Math.min(300, S.hpfFreq)) : 10);
    setP(G.eq2L.gain, S.g2EqLow); setP(G.eq2M.gain, S.g2EqMid); setP(G.eq2H.gain, S.g2EqHigh);
    if (S.g2CompOn) {
      setP(G.comp2.threshold, S.g2CompThr); setP(G.comp2.ratio, S.g2CompRatio);
      setP(G.mk2.gain, db2lin(Math.min(12, Math.max(0, (-S.g2CompThr) * (1 - 1 / S.g2CompRatio) * 0.4))));
    } else { setP(G.comp2.threshold, 0); setP(G.comp2.ratio, 1); setP(G.mk2.gain, 1); }
    setP(G.rev2.gain, !link2 && S.g2RevOn ? S.g2RevMix : 0);
    setP(G.echo2.gain, !link2 && S.g2EchoOn ? S.g2EchoMix : 0);
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
    setP(G.revSend.gain, S.revOn ? S.revMix : 0); setP(G.revWet.gain, 1); // 양은 보내는 쪽에서 (게스트는 자기 양으로 같은 울림에 보냄)
    setP(G.preDelay.delayTime, Math.max(0, Math.min(0.2, S.revPre)));
    setP(G.echoSend.gain, S.echoOn ? S.echoMix : 0); setP(G.echoWet.gain, 1);
    setP(G.echoDelay.delayTime, Math.max(0.05, Math.min(1.5, S.echoTime))); setP(G.echoFb.gain, Math.max(0, Math.min(0.85, S.echoFb)));
    setP(G.chSend.gain, S.chorusOn ? 1 : 0); setP(G.chWet.gain, S.chorusOn ? S.chorusMix : 0);
    // 음악 · 효과음
    setP(G.bgmGain.gain, S.bgmVol); setP(G.kNorm.gain, S.karaoke ? 0 : 1); setP(G.kOn.gain, S.karaoke ? 1 : 0);
    setP(G.pcGain.gain, S.pcVol); setP(G.padGain.gain, S.padVol); setP(G.botGain.gain, S.botVol);
    if (!S.bgmNorm) setP(G.bgmNorm.gain, 1, 0.3);
    applyAmb();
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
    if (slot === mic) {
      slot.src.connect(G.anRaw); warn.micLost = false;
      const tr = slot.s.getAudioTracks()[0];
      if (tr) tr.addEventListener('ended', () => { if (mic.s && mic.s.getAudioTracks()[0] === tr) warn.micLost = true; });
    }
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
    maybeIntro();
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
    normReset();
    await t.el.play();
    return true;
  }
  function stopBgm(o) { dropTrack(bgm.cur, o && o.fade ? Math.min(10, +o.fade) : 0); bgm.cur = null; bgm.url = ''; if (!jingle.t) normReset(); return true; }
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


  // ═════════ 📏 곡마다 소리 크기 맞추기 · 🚨 방송 사고 알림 ═════════
  //  0.1초마다 음악 소리 크기를 재서 "맞출 크기"에 가깝게 천천히 올리고/내린다 (새 곡은 처음 2초 동안 빠르게 맞춤)
  let normAvg = null, normFast = 0;
  function normReset() { normAvg = null; normFast = 20; }
  const warn = { micOff: 0, silent: false, clip: 0, clipSrc: '', micLost: false };
  let talkMs = 0, silentMs = 0, clipHits = [], watchTimer = null;
  function peakLin(an, buf) { an.getFloatTimeDomainData(buf); let pk = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; } return pk; }
  function startWatch() {
    const wb = new Float32Array(1024);
    watchTimer = setInterval(() => {
      if (!G) return;
      const now = Date.now(), live = active || testing;
      // 📏 음악 크기 맞추기
      if (S.bgmNorm) {
        const d = rmsDb(G.anBgm, wb);
        if (d > -50) { normAvg = normAvg == null ? d : normAvg + (d - normAvg) * (normFast > 0 ? 0.25 : 0.03); if (normFast > 0) normFast--; }
        const gdb = normAvg == null ? 0 : Math.max(-12, Math.min(6, S.normTarget - normAvg));
        setP(G.bgmNorm.gain, db2lin(gdb), normFast > 0 ? 0.15 : 0.8);
      }
      // 🔇 마이크 꺼둔 채 말하기 — 끄기 전 원음이 0.7초 넘게 말소리 크기면
      if (S.warnMicOff && S.micMute && live && mic.s) {
        if (rmsDb(G.anRaw, wb) > -42) talkMs += 100; else talkMs = Math.max(0, talkMs - 50);
        if (talkMs >= 700) { warn.micOff = now + 4000; talkMs = 0; }
      } else { talkMs = 0; if (!S.micMute) warn.micOff = 0; }
      // 🔈 무음 — 방송으로 나가는 소리가 정해둔 시간 넘게 거의 없으면 (마이크를 일부러 꺼둔 동안은 빼고)
      if (S.warnSilence && active && !S.micMute) {
        if (rmsDb(G.anOut, wb) < -60) silentMs += 100; else { silentMs = 0; warn.silent = false; }
        if (silentMs >= Math.max(5, S.silenceSec || 30) * 1000) warn.silent = true;
      } else { silentMs = 0; warn.silent = false; }
      // 🔴 소리 찢어짐 — 마이크 원음이 끝까지 차거나(마이크 쪽 볼륨이 너무 큼), 리미터 앞 소리가 너무 크면 (2초 안에 3번 넘게)
      if (S.warnClip && live) {
        const raw = mic.s ? peakLin(G.anRaw, wb) : 0, pre = peakLin(G.anPre, wb);
        if (raw >= 0.99 || pre >= 1.41) { clipHits.push(now); warn.clipSrc = raw >= 0.99 ? 'mic' : 'out'; }
        clipHits = clipHits.filter((t) => now - t < 2000);
        if (clipHits.length >= 3) warn.clip = now + 3000;
      } else { clipHits = []; warn.clip = 0; }
      showWarn();
    }, 100);
  }
  function warnList() {
    const now = Date.now(), out = [];
    if (warn.micLost && (active || testing)) out.push({ k: 'micLost', msg: '🎤 마이크 연결이 끊겼어요 — 마이크 선·장치를 확인해 주세요' });
    if (warn.micOff > now) out.push({ k: 'micOff', msg: '🔇 마이크가 꺼져 있어요! 말하는 소리가 방송에 안 나가요' });
    if (warn.silent) out.push({ k: 'silent', msg: `🔈 ${Math.round(silentMs / 1000)}초째 방송으로 나가는 소리가 없어요 — 마이크를 확인해 주세요` });
    if (warn.clip > now) out.push({ k: 'clip', msg: warn.clipSrc === 'mic' ? '🔴 마이크 소리가 너무 커서 찢어져요 — 윈도우 마이크 볼륨이나 입력 볼륨을 줄여주세요' : '🔴 소리가 너무 커요 — 출력·음악 볼륨을 조금 줄여주세요' });
    return out;
  }
  // 방송 창(스푼) 위쪽 가운데에 크게 띄우는 경고
  let warnKey = '';
  function showWarn() {
    try {
      const list = warnList(), key = list.map((w) => w.msg).join('|');
      if (key === warnKey) return;
      warnKey = key;
      let el = document.getElementById('__ediWarn');
      if (!list.length) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement('div'); el.id = '__ediWarn';
        el.style.cssText = 'position:fixed;left:50%;top:86px;transform:translateX(-50%);z-index:2147483647;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;max-width:min(560px,92vw)';
        document.body.appendChild(el);
      }
      el.innerHTML = '';
      list.forEach((w) => {
        const d = document.createElement('div');
        d.textContent = w.msg;
        d.style.cssText = 'background:' + (w.k === 'clip' ? '#ea580c' : '#dc2626') + ';color:#fff;font:800 15px/1.35 "Segoe UI",sans-serif;padding:10px 18px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.35);text-align:center';
        el.appendChild(d);
      });
    } catch (_) {}
  }

  // ═════════ 🎬 인트로 · 아웃트로 ═════════
  //  인트로: 방송이 켜지면(스푼이 마이크를 받아가면) 1.5초 뒤 한 번 (30분 안에 다시 켜지면 안 틀어요)
  //  아웃트로: 스푼 "라이브 종료"를 누르면 엔딩 음악을 먼저 틀고, 끝나면 라이브 종료를 대신 눌러서 종료 확인 창을 띄워요
  //           엔딩 중에 라이브 종료를 한 번 더 누르면 바로 종료
  let lastIntro = 0;
  const jingle = { t: null };
  async function playJingle(url) {
    await ready();
    if (jingle.t) dropTrack(jingle.t, 0.3);
    const t = mediaEl(url, G.bgmPre); // 음악 볼륨·덕킹·크기 맞추기를 같이 받는다
    jingle.t = t;
    t.el.onended = () => { if (jingle.t === t) jingle.t = null; try { t.src.disconnect(); t.g.disconnect(); } catch (_) {} };
    await t.el.play();
    return t;
  }
  function maybeIntro() {
    if (!S.introOn || !S.introUrl || Date.now() - lastIntro < 30 * 60 * 1000) return;
    lastIntro = Date.now();
    setTimeout(() => { if (active) playJingle(S.introUrl).catch(() => {}); }, 1500);
  }
  function isLiveEndBtn(el) { const t = (el && el.textContent || '').replace(/\s+/g, ' ').trim(); return t.length < 14 && t.includes('라이브 종료'); }
  function findLiveEnd() {
    const leaf = Array.from(document.querySelectorAll('button,a,[role=button],span,div')).find((x) => x.childElementCount === 0 && isLiveEndBtn(x) && x.offsetWidth > 0);
    return leaf ? (leaf.closest('button,a,[role=button]') || leaf) : null;
  }
  const outro = { busy: false, t: null, timer: null, bypass: false };
  function outroUi(on) {
    let el = document.getElementById('__ediOutro');
    if (!on) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement('div'); el.id = '__ediOutro';
    el.style.cssText = 'position:fixed;left:50%;top:86px;transform:translateX(-50%);z-index:2147483647;background:#4c1d95;color:#fff;font:700 14px/1.4 "Segoe UI",sans-serif;padding:12px 16px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center';
    const txt = document.createElement('span'); txt.textContent = '🎬 엔딩 음악 나가는 중 — 끝나면 라이브 종료 창이 떠요';
    const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'all:unset;cursor:pointer;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.45);border-radius:9px;padding:5px 10px;font-weight:800'; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
    el.appendChild(txt); el.appendChild(mk('바로 종료', () => finishOutro(true))); el.appendChild(mk('취소', () => cancelOutro()));
    document.body.appendChild(el);
  }
  function clearOutro(fade) { clearTimeout(outro.timer); if (outro.t) dropTrack(outro.t, fade); if (jingle.t === outro.t) jingle.t = null; outro.t = null; outro.busy = false; outroUi(false); }
  function cancelOutro() { clearOutro(1); }
  function finishOutro(now) {
    clearOutro(now ? 0.6 : 0);
    const btn = findLiveEnd();
    if (btn) { outro.bypass = true; try { btn.click(); } finally { outro.bypass = false; } }
  }
  async function startOutro() {
    if (outro.busy) return { ok: true, busy: true };
    if (!active) throw new Error('방송 중이 아니에요');
    if (!S.outroUrl) throw new Error('엔딩 음악 파일을 먼저 골라주세요');
    if (!findLiveEnd()) throw new Error('스푼 화면에서 라이브 종료 버튼을 못 찾았어요');
    outro.busy = true; outroUi(true);
    try { stopBgm({ fade: 1.5 }); } catch (_) {}
    try {
      const t = await playJingle(S.outroUrl);
      outro.t = t;
      t.el.addEventListener('ended', () => { if (outro.t === t) finishOutro(false); });
      outro.timer = setTimeout(() => { if (outro.t === t) finishOutro(true); }, 5 * 60 * 1000); // 너무 긴 파일이면 5분에서 끊기
    } catch (e) { clearOutro(0); throw new Error('엔딩 음악 재생 실패: ' + (e && e.message || e)); }
    return { ok: true };
  }
  // 스푼 "라이브 종료" 버튼을 누르면 → 엔딩 음악 먼저 (아웃트로를 켜둔 경우만)
  document.addEventListener('click', (e) => {
    if (outro.bypass || !active || !S.outroOn || !S.outroUrl) return;
    const btn = e.target && e.target.closest ? e.target.closest('button,a,[role=button]') : null;
    if (!btn || !isLiveEndBtn(btn)) return;
    if (outro.busy) { clearOutro(0.6); return; } // 엔딩 중에 한 번 더 누르면 바로 종료 (스푼 원래 동작 그대로)
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    startOutro().catch(() => { outro.busy = false; outroUi(false); finishOutro(true); });
  }, true);

  // ═════════ 🌧️ 배경 환경음 ═════════
  //  빗소리·파도·모닥불은 파일 없이 만들어서 끊김 없이 반복, "내 파일"은 고른 음악 파일을 반복
  const amb = { key: '', node: null, t: null };
  const ambCache = {};
  function ambBuffer(kind) {
    if (ambCache[kind]) return ambCache[kind];
    const sr = ctx.sampleRate, sec = kind === 'wave' ? 14 : 10, X = Math.floor(sr * 0.08), len = Math.floor(sr * sec) + X;
    const b = ctx.createBuffer(2, len - X, sr);
    for (let c = 0; c < 2; c++) {
      const d = new Float32Array(len);
      let lp = 0, lp2 = 0, br = 0, drop = 0, dropA = 0;
      for (let i = 0; i < len; i++) {
        const n = Math.random() * 2 - 1;
        if (kind === 'rain') {
          lp += 0.45 * (n - lp); lp2 += 0.02 * (lp - lp2);
          let v = (lp - lp2) * 0.35;
          if (Math.random() < 14 / sr) { drop = Math.floor(sr * (0.002 + Math.random() * 0.006)); dropA = 0.2 + Math.random() * 0.4; }
          if (drop > 0) { v += n * dropA * (drop / (sr * 0.008)); drop--; }
          d[i] = v;
        } else if (kind === 'wave') {
          br = (br + n * 0.02) * 0.998; lp += 0.08 * (br - lp);
          const ph = (i / sr) / 7 + (c ? 0.06 : 0);
          const env = 0.2 + 0.8 * Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * ph), 2);
          d[i] = lp * 3.2 * env;
        } else { // fire
          br = (br + n * 0.02) * 0.997; lp += 0.04 * (br - lp);
          let v = lp * 2.2;
          if (Math.random() < 9 / sr) { drop = Math.floor(sr * (0.001 + Math.random() * 0.003)); dropA = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.6); }
          if (drop > 0) { v += dropA * Math.random() * (drop / (sr * 0.004)); drop--; }
          d[i] = v;
        }
      }
      // 반복 이음새가 튀지 않게 끝부분을 앞부분에 겹쳐서 이어붙인다
      const o = b.getChannelData(c), L = len - X;
      for (let i = 0; i < L; i++) o[i] = i < X ? d[i] * (i / X) + d[L + i] * (1 - i / X) : d[i];
      let pk = 0; for (let i = 0; i < L; i++) pk = Math.max(pk, Math.abs(o[i]));
      const k = pk > 0 ? 0.6 / pk : 1; for (let i = 0; i < L; i++) o[i] *= k;
    }
    ambCache[kind] = b;
    return b;
  }
  function stopAmb() {
    try { if (amb.node) { amb.node.stop(); amb.node.disconnect(); } } catch (_) {}
    if (amb.t) dropTrack(amb.t, 0.5);
    amb.node = null; amb.t = null;
  }
  function applyAmb() {
    if (!G) return;
    const kind = ['rain', 'wave', 'fire', 'file'].includes(S.ambKind) ? S.ambKind : 'rain';
    const want = S.ambOn ? (kind === 'file' ? (S.ambUrl ? 'file:' + S.ambUrl : '') : kind) : '';
    setP(G.ambGain.gain, want ? Math.max(0, Math.min(1.5, S.ambVol)) : 0, 0.3);
    if (want === amb.key) return;
    stopAmb(); amb.key = want;
    if (!want) return;
    try {
      if (kind === 'file') {
        const t = mediaEl(S.ambUrl, G.ambGain); t.el.loop = true; amb.t = t;
        ready().then(() => t.el.play()).catch(() => {});
      } else {
        const n = ctx.createBufferSource(); n.buffer = ambBuffer(kind); n.loop = true; n.connect(G.ambGain); n.start(); amb.node = n;
        ready().catch(() => {});
      }
    } catch (_) { amb.key = ''; }
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
    levels: () => ({ mic: G ? peakDb(G.anGate) : -100, out: G ? peakDb(G.anOut) : -100, active, pc: !!pc.stream, bgm: bgmInfo(), rec: !!rec.mr, warn: G ? warnList() : [], outro: outro.busy, normDb: normAvg == null || !S.bgmNorm || !((bgm.cur && !bgm.cur.el.paused) || jingle.t) ? null : Math.round(Math.max(-12, Math.min(6, S.normTarget - normAvg)) * 10) / 10 }),
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
    outro: async (o) => (o && o.cancel ? (cancelOutro(), { ok: true }) : startOutro()),
  };
})();
