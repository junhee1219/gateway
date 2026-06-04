// GATEWAY — 오디오 엔진 (전부 Web Audio 합성, 외부 에셋 없음)
// BGM: 110BPM 신스웨이브 4코드 루프(Am-F-C-G), 위험도(intensity)에 따라 레이어가 살아남
// 주의: AudioContext는 반드시 사용자 제스처 안에서 init()을 불러 unlock해야 한다 (iOS)

const GatewayAudio = (() => {
  let ctx = null;
  let master, music, sfx, comp;
  let noiseBuf = null;
  let muted = localStorage.getItem('gatewayMuted') === '1';

  // ── 시퀀서 상태 ──
  const BPM = 124;                     // 몸이 들썩이는 템포
  const STEP = 60 / BPM / 4;          // 16분음표 길이
  let schedTimer = null;
  let nextStepTime = 0;
  let stepIdx = 0;                     // 0..63 (4마디 루프)
  let intensity = 0;                   // 0(평온)~1(위기), 목표값
  let curIntensity = 0;                // 부드럽게 따라가는 현재값
  let feverOn = false;
  let musicOn = false;
  let stepsScheduled = 0;              // QA: 시퀀서 생존 증명 (계속 증가해야 정상)

  // A minor 진행: Am - F - C - G (마디당 1코드)
  const CHORDS = [
    [57, 60, 64],   // A3 C4 E4
    [53, 57, 60],   // F3 A3 C4
    [48, 52, 55],   // C3 E3 G3
    [55, 59, 62],   // G3 B3 D4
  ];
  const BASS = [33, 29, 24, 31];       // A1 F1 C1 G1
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    music = ctx.createGain(); music.gain.value = 0.5;
    sfx = ctx.createGain(); sfx.gain.value = 0.85;
    music.connect(master); sfx.connect(master);
    master.connect(comp); comp.connect(ctx.destination);
    // 공유 노이즈 버퍼 (2초)
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // 사용자 제스처 안에서 호출 — iOS/크롬 unlock
  function init() {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
  }

  function setMuted(m) {
    muted = m;
    localStorage.setItem('gatewayMuted', m ? '1' : '0');
    if (ctx) master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.02);
  }

  // ── 합성 유틸 ──
  function env(g, t, a, peak, d, sustain = 0) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain || 0.0001), t + a + d);
  }
  function osc(type, freq, t) {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    return o;
  }
  function noise(t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    s.start(t); s.stop(t + dur + 0.05);
    return s;
  }

  // ── BGM 레이어 ──
  function playPad(t, chord) {
    const barLen = STEP * 16;
    chord.forEach((m) => {
      [-6, 6].forEach((cents) => { // 디튠 쌍 → 두툼한 패드
        const o = osc('sawtooth', mtof(m), t);
        o.detune.setValueAtTime(cents, t);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(500 + 1100 * curIntensity, t);
        f.Q.value = 0.8;
        const g = ctx.createGain();
        env(g, t, barLen * 0.25, 0.05, barLen * 0.95);
        o.connect(f); f.connect(g); g.connect(music);
        o.start(t); o.stop(t + barLen + 0.1);
      });
    });
  }

  function playBass(t, midi, accent) {
    const o = osc('square', mtof(midi), t);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.setValueAtTime(280 + 500 * curIntensity, t);
    const g = ctx.createGain();
    env(g, t, 0.005, accent ? 0.30 : 0.22, STEP * 1.8);
    o.connect(f); f.connect(g); g.connect(music);
    o.start(t); o.stop(t + STEP * 2);
  }

  function playArp(t, chord, step) {
    const tones = [...chord, chord[0] + 12, chord[1] + 12, chord[2] + 12];
    const m = tones[step % tones.length];
    const o = osc('triangle', mtof(m + 12), t);
    const g = ctx.createGain();
    const vol = 0.05 + 0.13 * curIntensity + (feverOn ? 0.05 : 0);
    env(g, t, 0.004, vol, STEP * 1.2);
    o.connect(g); g.connect(music);
    o.start(t); o.stop(t + STEP * 1.4);
  }

  function playKick(t) {
    const o = osc('sine', 150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.1);
    const g = ctx.createGain();
    env(g, t, 0.002, 0.65, 0.16);
    o.connect(g); g.connect(music);
    o.start(t); o.stop(t + 0.2);
  }

  function playHat(t, open) {
    const s = noise(t, open ? 0.18 : 0.05);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 7500;
    const g = ctx.createGain();
    env(g, t, 0.001, 0.07 + 0.07 * curIntensity, open ? 0.16 : 0.035);
    s.connect(f); f.connect(g); g.connect(music);
  }

  function playSnare(t) {
    const s = noise(t, 0.16);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.7;
    const g = ctx.createGain();
    env(g, t, 0.001, 0.25, 0.13);
    s.connect(f); f.connect(g); g.connect(music);
    const o = osc('triangle', 190, t); // 몸통
    const g2 = ctx.createGain();
    env(g2, t, 0.001, 0.15, 0.08);
    o.connect(g2); g2.connect(music);
    o.start(t); o.stop(t + 0.1);
  }

  // 한 스텝(16분음표) 스케줄
  function scheduleStep(t, idx) {
    stepsScheduled++;
    const bar = Math.floor(idx / 16) % 4;
    const step = idx % 16;
    const chord = CHORDS[bar];

    if (step === 0) playPad(t, chord);

    // 베이스: 8분음표 (intensity 0.15+)
    if (curIntensity > 0.15 && step % 2 === 0) playBass(t, BASS[bar] + (step % 8 === 6 ? 12 : 0), step % 4 === 0);

    // 아르페지오: 16분 (intensity 0.35+ 또는 피버)
    if ((curIntensity > 0.35 || feverOn) && step % 1 === 0) playArp(t, chord, idx);

    // 드럼
    if (curIntensity > 0.25 && step % 4 === 0) playKick(t);
    if (curIntensity > 0.25 && step % 2 === 1) playHat(t, false);
    if (curIntensity > 0.55) {
      if (step === 4 || step === 12) playSnare(t);
      if (step === 14) playHat(t, true);
    }
  }

  function schedulerTick() {
    curIntensity += (intensity - curIntensity) * 0.08; // 레이어 부드럽게 전환
    while (nextStepTime < ctx.currentTime + 0.14) {
      scheduleStep(nextStepTime, stepIdx);
      nextStepTime += STEP;
      stepIdx = (stepIdx + 1) % 64;
    }
  }

  function startMusic() {
    init();
    if (musicOn) return;
    musicOn = true;
    stepIdx = 0;
    nextStepTime = ctx.currentTime + 0.06;
    schedTimer = setInterval(schedulerTick, 30);
  }
  function stopMusic() {
    musicOn = false;
    clearInterval(schedTimer); schedTimer = null;
  }
  function setIntensity(x) { intensity = Math.max(0, Math.min(1, x)); }
  function setFever(f) { feverOn = f; }

  // ── SFX ──
  // 배출 완료: 크기별 음정 (작을수록 높고 가벼움, 클수록 무겁고 두둥)
  function drain(size, combo, rescue) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const base = size === 1 ? 740 : size === 2 ? 470 : 290;
    // 콤보가 쌓이면 음이 살짝 올라가서 "쌓이는 기분"
    const pitch = base * Math.pow(1.04, Math.min(combo, 12));
    const o = osc('sine', pitch, t);
    o.frequency.exponentialRampToValueAtTime(pitch * 1.5, t + 0.08);
    const g = ctx.createGain();
    env(g, t, 0.003, 0.3, 0.18);
    o.connect(g); g.connect(sfx);
    o.start(t); o.stop(t + 0.25);
    if (size === 3) { // L: 서브 두둥
      const s = osc('sine', 95, t);
      s.frequency.exponentialRampToValueAtTime(55, t + 0.18);
      const g2 = ctx.createGain();
      env(g2, t, 0.004, 0.5, 0.22);
      s.connect(g2); g2.connect(sfx);
      s.start(t); s.stop(t + 0.3);
    }
    if (rescue) { // 구사일생: 반짝이는 상승 아르페지오
      [0, 4, 7, 12].forEach((iv, i) => {
        const t2 = t + 0.05 + i * 0.05;
        const o2 = osc('triangle', mtof(81 + iv), t2);
        const g2 = ctx.createGain();
        env(g2, t2, 0.003, 0.16, 0.16);
        o2.connect(g2); g2.connect(sfx);
        o2.start(t2); o2.stop(t2 + 0.2);
      });
    }
  }

  // 게이트 이동: 노이즈 스윕 휘익
  function whoosh() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const s = noise(t, 0.22);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.6;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(2800, t + 0.16);
    const g = ctx.createGain();
    env(g, t, 0.01, 0.18, 0.18);
    s.connect(f); f.connect(g); g.connect(sfx);
  }

  function dock() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = osc('square', 1900, t);
    const g = ctx.createGain();
    env(g, t, 0.001, 0.07, 0.04);
    o.connect(g); g.connect(sfx);
    o.start(t); o.stop(t + 0.06);
  }

  // 펌핑: 짧은 상승 틱 — 연타할수록 음이 올라가 기분 좋게
  function pump(combo) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = 900 * Math.pow(1.03, Math.min(combo, 15));
    const o = osc('square', f, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.35, t + 0.05);
    const g = ctx.createGain();
    env(g, t, 0.001, 0.10, 0.05);
    o.connect(g); g.connect(sfx);
    o.start(t); o.stop(t + 0.07);
  }

  // 골드 획득: 빛나는 더블 차임
  function gold() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [88, 95, 100].forEach((m, i) => { // E6 B6 E7
      const o = osc('triangle', mtof(m), t + i * 0.07);
      const g = ctx.createGain();
      env(g, t + i * 0.07, 0.003, 0.22, 0.3);
      o.connect(g); g.connect(sfx);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.34);
    });
  }

  // 골드 증발: 시무룩 하강
  function goldLost() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = osc('triangle', 700, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.3);
    const g = ctx.createGain();
    env(g, t, 0.005, 0.16, 0.3);
    o.connect(g); g.connect(sfx);
    o.start(t); o.stop(t + 0.34);
  }

  // 위험 경고 (레인 90% 돌파)
  function warn() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, 0.13].forEach((d) => {
      const o = osc('square', 988, t + d);
      const g = ctx.createGain();
      env(g, t + d, 0.004, 0.13, 0.09);
      o.connect(g); g.connect(sfx);
      o.start(t + d); o.stop(t + d + 0.12);
    });
  }

  function comboUp(tier) { // 배수 단계 상승 차임
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, 4, 7].forEach((iv, i) => {
      const o = osc('triangle', mtof(76 + iv + tier * 3), t + i * 0.06);
      const g = ctx.createGain();
      env(g, t + i * 0.06, 0.004, 0.18, 0.22);
      o.connect(g); g.connect(sfx);
      o.start(t + i * 0.06); o.stop(t + i * 0.06 + 0.26);
    });
  }

  function abort() { // 배출 중단 피식
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = osc('sawtooth', 320, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.12);
    const g = ctx.createGain();
    env(g, t, 0.004, 0.1, 0.12);
    o.connect(g); g.connect(sfx);
    o.start(t); o.stop(t + 0.15);
  }

  function overflow() { // 폭발
    if (!ctx) return;
    const t = ctx.currentTime;
    const s = noise(t, 0.9);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(5500, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 0.8);
    const g = ctx.createGain();
    env(g, t, 0.003, 0.9, 0.8);
    s.connect(f); f.connect(g); g.connect(sfx);
    const o = osc('sine', 220, t); // 추락하는 톤
    o.frequency.exponentialRampToValueAtTime(38, t + 0.7);
    const g2 = ctx.createGain();
    env(g2, t, 0.003, 0.55, 0.7);
    o.connect(g2); g2.connect(sfx);
    o.start(t); o.stop(t + 0.85);
  }

  function gameOver() { // 하강 모티프
    if (!ctx) return;
    const t = ctx.currentTime + 0.45;
    [69, 65, 60, 57].forEach((m, i) => {
      const o = osc('triangle', mtof(m), t + i * 0.21);
      const g = ctx.createGain();
      env(g, t + i * 0.21, 0.01, 0.22, 0.34);
      o.connect(g); g.connect(sfx);
      o.start(t + i * 0.21); o.stop(t + i * 0.21 + 0.4);
    });
  }

  function record() { // 신기록 팡파레
    if (!ctx) return;
    const t = ctx.currentTime;
    [60, 64, 67, 72, 76].forEach((m, i) => {
      const o = osc('square', mtof(m), t + i * 0.09);
      const g = ctx.createGain();
      env(g, t + i * 0.09, 0.005, 0.14, 0.3);
      o.connect(g); g.connect(sfx);
      o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.35);
    });
  }

  function uiClick() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = osc('sine', 660, t);
    const g = ctx.createGain();
    env(g, t, 0.002, 0.12, 0.07);
    o.connect(g); g.connect(sfx);
    o.start(t); o.stop(t + 0.09);
  }

  return {
    init, setMuted, get muted() { return muted; },
    get ctx() { return ctx; },
    get steps() { return stepsScheduled; },
    get bpm() { return BPM; },
    startMusic, stopMusic, setIntensity, setFever,
    drain, whoosh, dock, pump, gold, goldLost, warn, comboUp, abort, overflow, gameOver, record, uiClick,
    suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); },
  };
})();

if (typeof window !== 'undefined') window.GatewayAudio = GatewayAudio;
