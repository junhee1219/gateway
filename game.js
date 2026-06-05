// GATEWAY — 렌더러 + 입력 + 이펙트 (코어 로직은 core.js)
// 목표: 눈이 돌아가는 몰입감 — 추가 합성 글로우, 파티클, 셰이크, 슬로모, 비트 동기 펄스
(() => {
  const Core = window.GatewayCore;
  const A = window.GatewayAudio;
  const C = Core.CONF;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // ── 레이아웃 ──
  let W = 0, H = 0, dpr = 1;
  let laneX = [], laneW = 0, tubeTop = 0, tubeBot = 0, unitH = 0, gateY = 0, coreY = 0;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const margin = Math.max(10, W * 0.04);
    // PC 와이드 화면에서 레인이 비대해지지 않게 보드 폭 제한 후 중앙 정렬
    const boardW = Math.min(W, 520, H * 0.66);
    const left = (W - boardW) / 2 + margin;
    laneW = (boardW - margin * 2) / 3;
    laneX = [left, left + laneW, left + laneW * 2];
    tubeTop = Math.max(86, H * 0.13);
    gateY = H * 0.74;
    tubeBot = gateY - 26;
    unitH = (tubeBot - tubeTop) / C.CAP;
    coreY = H * 0.9;
    initStars();
  }

  // ── 배경 ──
  let stars = [], buildings = [];
  function initStars() {
    stars = [];
    for (let L = 0; L < 3; L++) {
      const n = [40, 26, 14][L];
      for (let i = 0; i < n; i++) {
        stars.push({ x: Math.random() * W, y: Math.random() * H, L, tw: Math.random() * Math.PI * 2 });
      }
    }
    // 지평선 건물 실루엣 (결정적 배치)
    buildings = [];
    let bx = -20, i = 0;
    while (bx < W + 40) {
      const bw = 34 + ((i * 53) % 46);
      buildings.push({ x: bx, w: bw, h: 34 + ((i * 97) % 64), seed: i });
      bx += bw + 5; i++;
    }
  }

  // ── 상태 ──
  let mode = 'menu';           // menu | playing | over
  let game = null;
  let paused = false;
  let visOrbs = new Map();     // id → 시각 상태
  let drainVis = null;         // 배출 중 오브 시각 상태
  let particles = [], texts = [], ripples = [];
  let shake = 0, flash = 0, flashColor = '255,255,255', redPulse = 0, gateKick = 0;
  let timeScale = 1, slowmoT = 0;
  let lastWarnT = -9, prevMult = 1, feverGlow = 0;
  let scoreShown = 0;          // 점수 롤링
  let hueShift = 0;
  let overflowFx = null;       // { lane, t }
  let best = +localStorage.getItem('gatewayBest') || 0;

  // 라면집 팔레트 — 밤거리 포장마차의 따뜻한 빛
  const LCOL = [
    { main: '#ff6b6b', glow: 'rgba(255,107,107,', mid: '#97320e' },  // 빨강 등
    { main: '#ffa94d', glow: 'rgba(255,169,77,', mid: '#a3611e' },   // 주황 등
    { main: '#ffe066', glow: 'rgba(255,224,102,', mid: '#a3870e' },  // 노랑 등
  ];
  const SIZE_R = { 1: 0.16, 2: 0.23, 3: 0.30 }; // 반지름 = laneW * 비율
  const SIZE_COL = { // 손님: 혼밥러 / 커플 / 단체
    1: { main: '#ffd43b', glow: 'rgba(255,212,59,' },
    2: { main: '#ff922b', glow: 'rgba(255,146,43,' },
    3: { main: '#ff6b6b', glow: 'rgba(255,107,107,' },
  };
  const GOLD_COL = { main: '#ffe16b', glow: 'rgba(255,225,107,' }; // 먹방 BJ
  const orbCol = (v) => (v.gold ? GOLD_COL : SIZE_COL[v.size]);
  const MON = 10; // 표시용 환율: 내부 점수 100 = 1,000원 (라면 한 그릇)
  const won = (pts) => (pts * MON).toLocaleString() + '원';

  // ── 유틸 ──
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const rnd = (a, b) => a + Math.random() * (b - a);
  function vibrate(ms) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (e) {} }
  function beatPhase() { // 4분음표 위상 (0~1) — 비트 동기 펄스
    const per = 60 / (A.bpm || 124);
    if (A.ctx) return (A.ctx.currentTime % per) / per;
    return (performance.now() / 1000 % per) / per;
  }

  // ── 파티클 ──
  function burst(x, y, color, n, speed, life, size) {
    for (let i = 0; i < n; i++) {
      if (particles.length > 420) break;
      const a = Math.random() * Math.PI * 2;
      const v = rnd(speed * 0.3, speed);
      particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: rnd(life * 0.5, life), age: 0, color, size: rnd(size * 0.5, size), grav: 60,
      });
    }
  }
  function suck(x, y, tx, ty, color) { // 게이트로 빨려드는 입자
    if (particles.length > 420) return;
    particles.push({
      x: x + rnd(-18, 18), y: y + rnd(-18, 18),
      tx, ty, suckT: 0, life: rnd(0.25, 0.45), age: 0, color, size: rnd(1.5, 3.5), suck: true,
    });
  }
  function shock(x, y, color, maxR) {
    ripples.push({ x, y, r: 6, maxR, life: 0.45, age: 0, color });
  }
  function addText(x, y, str, color, size, crit) {
    texts.push({ x, y, str, color, size, crit, age: 0, life: crit ? 1.1 : 0.8, vy: -55 });
  }

  // ── 게임 시작/리셋 ──
  function startGame() {
    game = Core.createGame((Date.now() ^ (Math.random() * 1e9)) >>> 0);
    visOrbs.clear(); drainVis = null;
    particles = []; texts = []; ripples = [];
    shake = 0; flash = 0; timeScale = 1; slowmoT = 0;
    prevMult = 1; scoreShown = 0; overflowFx = null;
    mode = 'playing';
    document.body.classList.remove('show-overlay');
    A.init();          // 사용자 제스처 안 — AudioContext unlock
    A.startMusic();
    A.uiClick();
  }

  // ── 입력 ──
  function laneFromX(x) { return clamp(Math.floor(((x - laneX[0]) / laneW)), 0, 2); }
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    A.init(); // 모든 제스처에서 unlock 시도 (iOS 안전망)
    if (mode !== 'playing') return;
    if (paused) { resumeGame(); return; }
    const lane = laneFromX(e.clientX);
    ripples.push({ x: e.clientX, y: e.clientY, r: 4, maxR: 46, life: 0.3, age: 0, color: LCOL[lane].glow });
    Core.setGate(game, lane);
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (mode !== 'playing' || paused) return;
    if (e.key === '1' || e.key === '2' || e.key === '3') Core.setGate(game, +e.key - 1);
    if (e.key === 'ArrowLeft') Core.setGate(game, clamp((game.gate.moving ? game.gate.to : game.gate.lane) - 1, 0, 2));
    if (e.key === 'ArrowRight') Core.setGate(game, clamp((game.gate.moving ? game.gate.to : game.gate.lane) + 1, 0, 2));
  });

  // ── 일시정지 (탭 전환 시) ──
  function resumeGame() { paused = false; A.resume(); }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && mode === 'playing') { paused = true; A.suspend(); }
  });

  // ── 이벤트 → 이펙트 ──
  function laneCenter(lane) { return laneX[lane] + laneW / 2; }
  function handleEvents() {
    for (const ev of Core.drainEvents(game)) {
      const cx = ev.lane != null ? laneCenter(ev.lane) : W / 2;
      switch (ev.type) {
        case 'spawn': {
          burst(cx, tubeTop - 14, SIZE_COL[ev.size].glow, 6, 60, 0.4, 2.5);
          break;
        }
        case 'land': {
          const fillR = game.lanes[ev.lane].fill / C.CAP;
          burst(cx, stackTopY(ev.lane), LCOL[ev.lane].glow, 8, 90, 0.35, 2.5);
          if (fillR >= 0.8 && game.t - lastWarnT > 1.6) {
            lastWarnT = game.t; A.warn(); redPulse = 1; vibrate(30);
          }
          break;
        }
        case 'switch': A.whoosh(); break;
        case 'pump': {
          A.pump(game.combo);
          gateKick = 1;
          burst(cx, gateY, game.drain ? orbCol({ gold: false, size: game.drain.size }).glow : 'rgba(255,255,255,', 3, 110, 0.25, 2);
          vibrate(6);
          break;
        }
        case 'goldLost': {
          A.goldLost();
          burst(cx, stackTopY(ev.lane), 'rgba(180,170,140,', 14, 80, 0.5, 2.5);
          addText(cx, stackTopY(ev.lane) - 20, 'BJ가 떠났다… ⭐0.5', '#b8ae8c', 15, false);
          break;
        }
        case 'docked': {
          A.dock();
          shock(laneCenter(ev.lane), gateY, LCOL[ev.lane].glow, 40);
          break;
        }
        case 'drainStart': break;
        case 'drain': {
          const col = ev.gold ? GOLD_COL : SIZE_COL[ev.size];
          const n = (ev.gold ? 34 : ev.size === 3 ? 26 : ev.size === 2 ? 16 : 10);
          burst(cx, gateY, col.glow, n, 170 + ev.size * 40 + (ev.gold ? 80 : 0), 0.55, 3.5);
          shock(cx, gateY, col.glow, 60 + ev.size * 18 + (ev.gold ? 40 : 0));
          shake = Math.max(shake, ev.gold ? 8 : ev.size === 3 ? 7 : ev.size === 2 ? 4 : 2);
          addText(cx, gateY - 46, `+${won(ev.pts)}${ev.gold ? ' ✨' : ''}`, ev.rescue || ev.gold ? '#ffe16b' : col.main,
            16 + ev.size * 4 + (ev.mult > 1 ? 4 : 0) + (ev.gold ? 6 : 0), ev.rescue || ev.gold);
          if (ev.gold) {
            A.gold();
            addText(cx, gateY - 104, '먹방 대박! 🎥', '#ffe16b', 18, true);
            flash = Math.max(flash, 0.3); flashColor = '255,225,107';
          }
          if (ev.rescue) {
            addText(cx, gateY - 78, '겨우 달랬다! ×2', '#ffe16b', 17, true);
            flash = Math.max(flash, 0.25); flashColor = '255,225,107';
          }
          const mult = Core.comboMult(ev.combo);
          if (mult > prevMult) {
            A.comboUp(mult >= 3 ? 2 : mult >= 2 ? 1 : 0);
            addText(W / 2, H * 0.30, `단골 행렬! 팁 ×${mult}`, '#9dff8a', 26, true);
            shock(W / 2, H * 0.30, 'rgba(157,255,138,', 90);
          }
          prevMult = mult;
          A.drain(ev.size, ev.combo, ev.rescue);
          vibrate(ev.size === 3 ? 24 : 10);
          break;
        }
        case 'abort': {
          A.abort();
          burst(cx, gateY, 'rgba(255,110,110,', 7, 70, 0.3, 2);
          break;
        }
        case 'comboBreak': prevMult = 1; break;
        case 'overflow': {
          overflowFx = { lane: ev.lane, t: 0 };
          A.overflow(); A.stopMusic(); A.gameOver();
          shake = 22; flash = 0.9; flashColor = '255,80,80';
          slowmoT = 0.9; timeScale = 0.15;
          burst(cx, tubeTop + 30, 'rgba(255,90,90,', 60, 320, 1.0, 5);
          burst(cx, (tubeTop + tubeBot) / 2, LCOL[ev.lane].glow, 40, 260, 0.9, 4);
          shock(cx, (tubeTop + tubeBot) / 2, 'rgba(255,90,90,', 220);
          vibrate([60, 40, 120]);
          setTimeout(showGameOver, 1100);
          break;
        }
      }
    }
  }

  // ── 게임오버 화면 ──
  const COFFEE = 300000; // 커피 이스터에그 (매출 300만원 — test.js 스마트봇 최고 16.2만의 1.85배)
  function deathMessage(score) {
    const sales = (score * MON).toLocaleString() + '원';
    if (score >= COFFEE) return {
      e: '🏆', t: '전설의 라면 장인!',
      m: `매출 <b>${sales}</b>?! 이건 개발자도 못 찍은 기록이에요.<br>너무 고수라서 개발자가 커피 한 잔 사겠습니다 ☕<br><a href="mailto:junhee@finda.co.kr">junhee@finda.co.kr</a> 로 연락 주세요!`,
    };
    if (score >= 150000) return {
      e: '👑', t: '골목 맛집 등극!',
      m: `매출 <b>${sales}</b>! ⭐4.9 "여기 사장님 미쳤어요"<br>${(COFFEE * MON).toLocaleString()}원을 찍으면 좋은 일이 생긴다는 소문이...`,
    };
    if (score >= 70000) return {
      e: '🔥', t: '입소문이 돈다',
      m: `매출 <b>${sales}</b>! ⭐4.5 "줄 서서 먹는 집"<br>세 줄을 동시에 읽는 눈, 예사롭지 않은데요?`,
    };
    if (score >= 25000) return {
      e: '🍜', t: '오늘 장사 좀 되네',
      m: `매출 <b>${sales}</b>! ⭐4.0 "가끔 늦지만 맛있어요"<br>먹방 BJ(⭐)를 놓치지 마세요, 5배입니다`,
    };
    if (score >= 6000) return {
      e: '🌱', t: '개업 효과',
      m: `매출 <b>${sales}</b>! ⭐3.5 "사장님이 착해요"<br>같은 줄 연타(빨리빨리!)로 회전율을 올려봐요`,
    };
    if (score >= 1) return {
      e: '🥢', t: '주방 견습',
      m: `매출 <b>${sales}</b>! ⭐2.5 "기다리다 갔어요"<br>줄을 탭하면 그쪽으로 서빙, 연타하면 빨라져요`,
    };
    return { e: '🥚', t: '개점휴업', m: '⭐1.0 "사장님이 안 계세요" 🥲<br>줄을 탭해서 손님을 받아봐요' };
  }

  function showGameOver() {
    mode = 'over';
    const isRecord = game.score > 0 && game.score > best;
    if (isRecord) {
      best = game.score;
      localStorage.setItem('gatewayBest', best);
      setTimeout(() => A.record(), 600);
    }
    const { e, t, m } = deathMessage(game.score);
    const ov = document.getElementById('overlay');
    document.getElementById('ov-emoji').textContent = e;
    ov.querySelector('h1').textContent = t;
    ov.querySelector('#ov-msg').innerHTML =
      (isRecord ? '<span class="newrecord">🎉 매출 신기록! 🎉</span><br>' : '') + m +
      (game.maxCombo >= 5 ? `<br><span class="sub">연속 서빙 🔥x${game.maxCombo} · 손님 ${game.stats.drained}팀 · 빨리빨리 ${game.stats.pumps}번</span>` : '');
    document.getElementById('btn-start').textContent = '다시 장사하기!';
    ov.classList.add('gameover');
    document.body.classList.add('show-overlay');
  }

  // ── 업데이트 ──
  let lastT = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (paused) { draw(); drawPaused(); return; }

    if (slowmoT > 0) { slowmoT -= dt; if (slowmoT <= 0) timeScale = 1; }
    const gdt = dt * timeScale;

    if (mode === 'playing') {
      Core.update(game, gdt);
      handleEvents();
      // 바닥 0.3: 시작부터 드럼이 들어와 음악이 비어있지 않게
      A.setIntensity(Math.max(0.3, Core.dangerLevel(game) * 0.85 + Math.min(0.3, game.combo * 0.015)));
      A.setFever(game.combo >= 10);
    }
    if (overflowFx) overflowFx.t += dt;

    updateVisuals(gdt, dt);
    draw();
  }

  function stackTopY(lane) {
    return tubeBot - game.lanes[lane].fill * unitH;
  }

  function updateVisuals(gdt, dt) {
    if (game) {
      // 큐 오브 목표 위치 동기화 (스프링 정착)
      for (let l = 0; l < 3; l++) {
        let yBase = tubeBot;
        for (const orb of game.lanes[l].queue) {
          const r = laneW * SIZE_R[orb.size];
          const targetY = yBase - orb.size * unitH / 2;
          let v = visOrbs.get(orb.id);
          if (!v) { v = { x: laneCenter(l), y: targetY, vy: 0, r, size: orb.size, lane: l, ph: Math.random() * 7 }; visOrbs.set(orb.id, v); }
          v.lane = l; v.r = r; v.gold = !!orb.gold; v.expire = orb.expire || 0; v.falling = false;
          const k = 120, damp = 10;                       // 스프링
          v.vy += (targetY - v.y) * k * dt; v.vy -= v.vy * damp * dt;
          v.y += v.vy * dt;
          yBase -= orb.size * unitH;
        }
      }
      // 낙하 오브
      for (const o of game.falling) {
        let v = visOrbs.get(o.id);
        const p = 1 - o.timer / C.FALL_TIME;
        const targetTop = stackTopY(o.lane) - o.size * unitH / 2;
        const y = lerp(tubeTop - 30, targetTop, p * p);   // 가속 낙하
        if (!v) { v = { x: laneCenter(o.lane), y, vy: 0, r: laneW * SIZE_R[o.size], size: o.size, lane: o.lane, ph: Math.random() * 7, falling: true, gold: !!o.gold }; visOrbs.set(o.id, v); }
        v.y = y; v.falling = true;
        if (Math.random() < (v.gold ? 0.9 : 0.5)) suck(v.x, v.y - 8, v.x, v.y - 26, orbCol(v).glow); // 트레일
      }
      // 사라진 오브 정리
      const aliveIds = new Set();
      for (let l = 0; l < 3; l++) for (const o of game.lanes[l].queue) aliveIds.add(o.id);
      for (const o of game.falling) aliveIds.add(o.id);
      for (const id of visOrbs.keys()) if (!aliveIds.has(id)) visOrbs.delete(id);
      // 배출 중 빨림 입자
      if (game.drain && !game.gate.moving) {
        const cx = laneCenter(game.gate.lane);
        if (Math.random() < 0.8) suck(cx + rnd(-laneW * 0.3, laneW * 0.3), gateY - rnd(10, 60), cx, gateY, SIZE_COL[game.drain.size].glow);
      }
      // 점수 롤링
      scoreShown = lerp(scoreShown, game.score, 1 - Math.pow(0.001, dt));
      if (Math.abs(scoreShown - game.score) < 1) scoreShown = game.score;
    }
    // 파티클
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      if (p.suck) {
        p.suckT += dt / p.life;
        p.x = lerp(p.x, p.tx, p.suckT * 0.5);
        p.y = lerp(p.y, p.ty, p.suckT * 0.5);
      } else {
        p.vy += (p.grav || 0) * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
    }
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i]; t.age += dt; t.y += t.vy * dt; t.vy *= 0.92;
      if (t.age >= t.life) texts.splice(i, 1);
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i]; r.age += dt; r.r = lerp(r.r, r.maxR, r.age / r.life);
      if (r.age >= r.life) ripples.splice(i, 1);
    }
    shake = Math.max(0, shake - dt * 26);
    gateKick = Math.max(0, gateKick - dt * 9);
    flash = Math.max(0, flash - dt * 2.2);
    redPulse = Math.max(0, redPulse - dt * 1.4);
    feverGlow = lerp(feverGlow, (game && game.combo >= 10) ? 1 : 0, dt * 4);
    hueShift += dt * (8 + feverGlow * 40);
  }

  // ── 그리기 ──
  function draw() {
    ctx.save();
    if (shake > 0.3) ctx.translate(rnd(-shake, shake), rnd(-shake, shake));

    drawBackground();
    if (game) {
      drawLanes();
      drawOrbs();
      drawGate();
      drawCore();
      drawParticles();
      drawHud();
    }
    ctx.restore();

    // 플래시 / 위험 비네트
    if (flash > 0) {
      ctx.fillStyle = `rgba(${flashColor},${flash * 0.5})`;
      ctx.fillRect(0, 0, W, H);
    }
    const danger = game && mode === 'playing' ? Core.dangerLevel(game) : 0;
    const vig = Math.max(danger > 0.78 ? (danger - 0.78) * 4 : 0, redPulse) * (0.5 + 0.5 * Math.sin(performance.now() / 110));
    if (vig > 0.02) {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.72);
      g.addColorStop(0, 'rgba(255,40,40,0)');
      g.addColorStop(1, `rgba(255,40,40,${clamp(vig, 0, 0.5)})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }

  function drawBackground() {
    const beat = beatPhase();
    const pulse = Math.pow(1 - beat, 2) * 0.05; // 비트마다 살짝 밝아짐
    const t = performance.now() / 1000;
    const fv = feverGlow;
    const hz = Math.max(70, tubeTop - 26); // 지평선

    // 해질녘 하늘 (시커멓지 않게!)
    const sky = ctx.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, `hsl(${262 + fv * 8}, 36%, ${24 + pulse * 30}%)`);
    sky.addColorStop(0.6, `hsl(${352 + fv * 6}, 44%, ${37 + pulse * 30}%)`);
    sky.addColorStop(1, `hsl(${26 + fv * 6}, ${62 + fv * 15}%, ${48 + pulse * 30}%)`);
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, hz);

    // 초저녁 별
    for (const s of stars) {
      const y = (s.y * 0.4 + t * [2, 4, 7][s.L]) % (hz * 0.7);
      const a = 0.15 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2 + s.tw)) * (s.L + 1) / 3;
      ctx.fillStyle = `rgba(255,244,220,${a})`;
      ctx.fillRect(s.x, y, (s.L + 1) * 0.6, (s.L + 1) * 0.6);
    }

    // 건물 실루엣 + 창문 불빛
    ctx.fillStyle = 'rgba(40,24,52,0.9)';
    for (const b of buildings) ctx.fillRect(b.x, hz - b.h, b.w, b.h);
    ctx.fillStyle = 'rgba(255,214,120,0.6)';
    for (const b of buildings) {
      for (let k = 0; k < 4; k++) {
        if ((b.seed * 7 + k * 3) % 5 < 2) continue;
        ctx.fillRect(b.x + 6 + (k % 2) * 14, hz - b.h + 8 + Math.floor(k / 2) * 16, 6, 8);
      }
    }

    // 골목 바닥 (가게 앞)
    const gnd = ctx.createLinearGradient(0, hz, 0, H);
    gnd.addColorStop(0, `hsl(18, 30%, ${30 + pulse * 20}%)`);
    gnd.addColorStop(1, `hsl(14, 32%, ${17 + pulse * 16}%)`);
    ctx.fillStyle = gnd; ctx.fillRect(0, hz, W, H - hz);
    // 가게 불빛이 바닥에 번짐
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const wash = ctx.createRadialGradient(W / 2, gateY + 26, 10, W / 2, gateY + 26, W * 0.75);
    wash.addColorStop(0, `rgba(255,186,96,${0.20 + pulse * 1.5 + fv * 0.08})`);
    wash.addColorStop(1, 'rgba(255,186,96,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, hz, W, H - hz);
    ctx.restore();

    // 전선에 매달린 홍등 3개 (각 줄 위)
    ctx.save();
    for (let l = 0; l < 3; l++) {
      const cx = laneX[l] + laneW / 2 + Math.sin(t * 0.9 + l * 2.1) * 5;
      const cy = Math.max(40, tubeTop - 48);
      ctx.globalCompositeOperation = 'lighter';
      const lg = ctx.createRadialGradient(cx, cy, 2, cx, cy, 44);
      lg.addColorStop(0, LCOL[l].glow + (0.5 + pulse * 3) + ')');
      lg.addColorStop(1, LCOL[l].glow + '0)');
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.arc(cx, cy, 44, 0, 7); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = LCOL[l].main;
      ctx.beginPath(); ctx.ellipse(cx, cy, 9, 11, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,200,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, cy - 11); ctx.lineTo(cx, 0); ctx.stroke();
    }
    ctx.restore();

    // 가게 차양 (빨강·크림 스캘럽) — 카운터 위
    const awnTop = gateY - 50, awnH = 22, sc = 13;
    for (let x = 0, i = 0; x < W; x += 26, i++) {
      ctx.fillStyle = i % 2 ? '#f3e2c4' : '#e8453c';
      ctx.fillRect(x, awnTop, 26, awnH);
      ctx.beginPath();
      ctx.arc(x + 13, awnTop + awnH, sc, 0, Math.PI);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; // 차양 그림자
    ctx.fillRect(0, awnTop + awnH + sc, W, 5);
  }

  function drawLanes() {
    const t = performance.now() / 1000;
    for (let l = 0; l < 3; l++) {
      const x = laneX[l], cx = laneCenter(l);
      const fill = game.lanes[l].fill / C.CAP;
      const proj = Core.projectedFill(game, l) / C.CAP;
      const hot = fill >= 0.8;
      const alarm = hot ? 0.5 + 0.5 * Math.sin(performance.now() / 90) : 0;
      const active = l === currentGateLane();

      // 대기줄 바닥 매트 (밝은 카펫 — 가게 앞 줄서기 자리)
      ctx.fillStyle = hot
        ? `rgba(255,90,70,${0.16 + alarm * 0.14})`
        : `rgba(255,232,190,${active ? 0.14 : 0.08})`;
      roundRect(x + 6, tubeTop - 6, laneW - 12, tubeBot - tubeTop + 18, 12);
      ctx.fill();

      // 줄 안내 중앙 점선 (바닥 페인트)
      ctx.setLineDash([5, 12]);
      ctx.strokeStyle = 'rgba(255,240,210,0.20)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, tubeTop + 8); ctx.lineTo(cx, tubeBot); ctx.stroke();
      ctx.setLineDash([]);

      // 차단봉 + 로프 (양옆)
      const postYs = [tubeTop + 2, (tubeTop + tubeBot) / 2, tubeBot - 2];
      [x + 11, x + laneW - 11].forEach((px) => {
        // 로프 (살짝 처진 곡선)
        ctx.strokeStyle = hot ? `rgba(255,120,90,${0.6 + alarm * 0.3})` : 'rgba(222,178,108,0.65)';
        ctx.lineWidth = 2;
        for (let k = 0; k < postYs.length - 1; k++) {
          ctx.beginPath();
          ctx.moveTo(px, postYs[k] - 8);
          ctx.quadraticCurveTo(px + (px < cx ? 4 : -4), (postYs[k] + postYs[k + 1]) / 2, px, postYs[k + 1] - 8);
          ctx.stroke();
        }
        // 봉
        postYs.forEach((py) => {
          ctx.strokeStyle = '#caa257';
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(px, py - 8); ctx.lineTo(px, py + 6); ctx.stroke();
          ctx.fillStyle = '#e8c878';
          ctx.beginPath(); ctx.arc(px, py - 9, 3.2, 0, 7); ctx.fill();
        });
      });

      // 만석 위험선 (줄 맨 끝 — 도로 침범 금지선)
      ctx.setLineDash([10, 8]);
      ctx.lineWidth = hot ? 5 + alarm * 2 : 3;
      ctx.strokeStyle = hot ? `rgba(255,70,60,${0.7 + alarm * 0.3})` : 'rgba(255,200,70,0.45)';
      ctx.beginPath(); ctx.moveTo(x + 12, tubeTop - 12); ctx.lineTo(x + laneW - 12, tubeTop - 12); ctx.stroke();
      ctx.setLineDash([]);

      // 줄 포화도 라벨
      const pct = Math.round(proj * 100);
      ctx.font = `bold ${hot ? 15 : 12}px -apple-system,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = hot ? `rgba(255,${130 - alarm * 60},${110 - alarm * 60},1)` : 'rgba(255,248,230,0.55)';
      ctx.fillText((hot ? '⚠ ' : '') + pct + '%', cx, tubeTop + 14);
    }
  }

  function currentGateLane() { return game.gate.moving ? -1 : game.gate.lane; }

  function drawOrbs() {
    ctx.save();
    const t = performance.now() / 1000;
    for (const v of visOrbs.values()) {
      const col = orbCol(v);
      const wob = Math.sin(t * 3 + v.ph) * 1.5;
      const yy = v.y + wob;
      // 줄이 찰수록 손님들이 화남 (낙하 중엔 아직 태평)
      const anger = v.falling ? 0 : (game.lanes[v.lane] ? game.lanes[v.lane].fill / C.CAP : 0);
      drawOrb(v.x, yy, v.r, col, v.size, t + v.ph, anger, v.gold);
      // 골드: 증발 카운트다운 링
      if (v.gold && v.expire > 0 && game.alive) {
        const remain = clamp((v.expire - game.t) / C.GOLD.life, 0, 1);
        ctx.strokeStyle = remain < 0.35 ? `rgba(255,90,90,${0.6 + 0.4 * Math.sin(t * 18)})` : 'rgba(255,225,107,0.85)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(v.x, yy, v.r + 7, -Math.PI / 2, -Math.PI / 2 + remain * Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
    // 배출 중 오브 (게이트로 빨려들기)
    if (game.drain && !game.gate.moving) {
      const lane = game.lanes[game.gate.lane];
      const orb = lane.queue[0];
      if (orb) {
        const v = visOrbs.get(orb.id);
        if (v) {
          const p = game.drain.progress;
          v.y = lerp(v.y, gateY, p * 0.6);
          const sq = 1 - p * 0.5;
          ctx.save();
          ctx.translate(v.x, v.y);
          ctx.scale(sq, 1 + p * 0.55); // 라면 받으러 쏙 들어감
          drawOrb(0, 0, v.r, orbCol(v), v.size, performance.now() / 1000, 0, v.gold); // 서빙받는 중 = 행복
          ctx.restore();
        }
      }
    }
  }

  // 얼굴 한 개 (눈+입) — anger: 0 평온 ~ 1 분노
  function drawFace(fx, fy, s, anger, t, gold) {
    const blink = Math.sin(t * 1.3) > 0.97 ? 0.2 : 1; // 가끔 깜빡
    ctx.fillStyle = '#3b2a1a';
    if (gold) { // 먹방 BJ: 선글라스
      ctx.fillRect(fx - s * 0.62, fy - s * 0.30, s * 0.5, s * 0.3);
      ctx.fillRect(fx + s * 0.12, fy - s * 0.30, s * 0.5, s * 0.3);
      ctx.fillRect(fx - s * 0.2, fy - s * 0.24, s * 0.4, s * 0.1);
    } else if (anger > 0.85) { // 분노: 치켜뜬 눈썹눈
      ctx.lineWidth = s * 0.13; ctx.strokeStyle = '#3b2a1a';
      ctx.beginPath(); ctx.moveTo(fx - s * 0.5, fy - s * 0.34); ctx.lineTo(fx - s * 0.14, fy - s * 0.12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(fx + s * 0.5, fy - s * 0.34); ctx.lineTo(fx + s * 0.14, fy - s * 0.12); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(fx - s * 0.3, fy - s * 0.18, s * 0.11, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(fx + s * 0.3, fy - s * 0.18, s * 0.11 * blink, 0, 7); ctx.fill();
    }
    // 입
    ctx.lineWidth = Math.max(1.2, s * 0.1); ctx.strokeStyle = '#3b2a1a';
    ctx.beginPath();
    if (anger > 0.85) { ctx.arc(fx, fy + s * 0.42, s * 0.22, Math.PI, 0); } // 뒤집힌 울상+벌린 입
    else if (anger > 0.55) { ctx.moveTo(fx - s * 0.22, fy + s * 0.3); ctx.lineTo(fx + s * 0.22, fy + s * 0.3); } // 일자
    else { ctx.arc(fx, fy + s * 0.18, s * 0.26, 0.25, Math.PI - 0.25); } // 미소
    ctx.stroke();
    if (anger > 0.85) { // 분노 홍조
      ctx.fillStyle = 'rgba(255,80,80,0.45)';
      ctx.beginPath(); ctx.arc(fx - s * 0.5, fy + s * 0.12, s * 0.14, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(fx + s * 0.5, fy + s * 0.12, s * 0.14, 0, 7); ctx.fill();
    }
  }

  // 손님 그리기 — size 1/2/3 = 얼굴 1/2/3개 (혼밥러/커플/단체)
  function drawOrb(x, y, r, col, size, t, anger = 0, gold = false) {
    const jit = anger > 0.85 ? Math.sin(t * 40) * r * 0.05 : 0; // 분노 부들부들
    x += jit;
    ctx.save();
    // 따뜻한 할로
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 2);
    g.addColorStop(0, col.glow + (gold ? '0.55)' : '0.35)'));
    g.addColorStop(1, col.glow + '0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 2, 0, 7); ctx.fill();
    ctx.restore();
    // 몸통 (불투명 — 얼굴이 잘 보이게)
    const g2 = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    g2.addColorStop(0, '#fff6e0');
    g2.addColorStop(0.42, col.main);
    g2.addColorStop(1, col.main);
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(60,30,10,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
    // 얼굴들
    if (size === 1) drawFace(x, y, r * 0.75, anger, t, gold);
    else if (size === 2) {
      drawFace(x - r * 0.42, y, r * 0.5, anger, t, gold);
      drawFace(x + r * 0.42, y + r * 0.06, r * 0.5, anger, t + 3, gold);
    } else {
      drawFace(x - r * 0.45, y + r * 0.18, r * 0.42, anger, t, gold);
      drawFace(x + r * 0.45, y + r * 0.18, r * 0.42, anger, t + 3, gold);
      drawFace(x, y - r * 0.4, r * 0.42, anger, t + 5, gold);
    }
    // 분노 김
    if (anger > 0.85 && Math.random() < 0.25) {
      ctx.font = `${Math.round(r * 0.55)}px serif`;
      ctx.textAlign = 'center';
      ctx.fillText('💢', x + r * 0.9, y - r * 0.8);
    }
    if (gold) { // BJ 별
      ctx.font = `${Math.round(r * 0.7)}px serif`;
      ctx.textAlign = 'center';
      ctx.fillText('⭐', x, y - r * 1.25);
    }
  }

  function drawGate() {
    const gx = laneX[0] + laneW / 2 + game.gate.x * laneW;
    const t = performance.now() / 1000;
    const draining = game.drain && !game.gate.moving;
    const kick = 1 + gateKick * 0.14; // 빨리빨리 연타 시 들썩
    const R = laneW * 0.3;
    ctx.save();
    // 서빙 온기 (창구 → 돈통)
    if (draining) {
      const col = SIZE_COL[game.drain.size];
      ctx.globalCompositeOperation = 'lighter';
      const bg = ctx.createLinearGradient(0, gateY, 0, coreY);
      bg.addColorStop(0, col.glow + '0.4)');
      bg.addColorStop(1, col.glow + '0.04)');
      ctx.fillStyle = bg;
      const bw = 7 + Math.sin(t * 30) * 2 + game.drain.size * 2;
      ctx.beginPath();
      ctx.moveTo(gx - bw, gateY); ctx.lineTo(gx + bw, gateY);
      ctx.lineTo(W / 2 + bw * 0.6, coreY); ctx.lineTo(W / 2 - bw * 0.6, coreY);
      ctx.fill();
    }
    // 활성 창구 따뜻한 글로우
    ctx.globalCompositeOperation = 'lighter';
    const col = game.gate.moving ? 'rgba(255,255,255,' : LCOL[clamp(Math.round(game.gate.x), 0, 2)].glow;
    const hg = ctx.createRadialGradient(gx, gateY + 4, R * 0.3, gx, gateY + 4, R * 2.1);
    hg.addColorStop(0, col + '0.4)');
    hg.addColorStop(1, col + '0)');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(gx, gateY + 4, R * 2.1, 0, 7); ctx.fill();
    ctx.restore();

    // 나무 카운터 (가게 전면, 전체 폭)
    ctx.fillStyle = '#7c4a22';
    roundRect(8, gateY + 14, W - 16, 30, 8); ctx.fill();
    ctx.fillStyle = 'rgba(255,220,160,0.28)';
    roundRect(8, gateY + 14, W - 16, 6, 3); ctx.fill();

    // 사장님 (활성 창구 위치로 미끄러져 다님)
    const fr = laneW * 0.17 * kick;
    const fy = gateY - 4 + (draining ? Math.sin(t * 24) * 1.6 : Math.sin(t * 2.4));
    // 몸통 (흰 앞치마)
    ctx.fillStyle = '#f5eee2';
    roundRect(gx - fr * 1.1, fy + fr * 0.55, fr * 2.2, fr * 1.5, 6); ctx.fill();
    // 얼굴
    ctx.fillStyle = '#ffd9a8';
    ctx.beginPath(); ctx.arc(gx, fy, fr, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(90,50,20,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(gx, fy, fr, 0, 7); ctx.stroke();
    // 흰 두건
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(gx, fy, fr, Math.PI * 1.05, Math.PI * 1.95);
    ctx.quadraticCurveTo(gx + fr * 0.6, fy - fr * 0.45, gx - fr * 0.98, fy - fr * 0.3);
    ctx.fill();
    ctx.fillStyle = '#e84a3c'; // 두건 띠
    roundRect(gx - fr, fy - fr * 0.5, fr * 2, fr * 0.22, fr * 0.1); ctx.fill();
    // 눈/입 — 서빙 중엔 집중, 평소엔 싱글벙글
    ctx.fillStyle = '#3b2a1a';
    ctx.strokeStyle = '#3b2a1a';
    if (draining) {
      ctx.lineWidth = fr * 0.13;
      ctx.beginPath(); ctx.moveTo(gx - fr * 0.45, fy - fr * 0.05); ctx.lineTo(gx - fr * 0.15, fy - fr * 0.05); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(gx + fr * 0.15, fy - fr * 0.05); ctx.lineTo(gx + fr * 0.45, fy - fr * 0.05); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(gx - fr * 0.3, fy - fr * 0.08, fr * 0.1, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(gx + fr * 0.3, fy - fr * 0.08, fr * 0.1, 0, 7); ctx.fill();
    }
    ctx.lineWidth = fr * 0.11;
    ctx.beginPath(); ctx.arc(gx, fy + fr * 0.3, fr * 0.26, 0.3, Math.PI - 0.3); ctx.stroke();

    // 그릇 (카운터 위, 사장님 옆에서 김 모락)
    ctx.font = `${Math.round(fr * 1.5)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🍜', gx + fr * 2.1, gateY + 24 + (draining ? Math.sin(t * 26) * 2 : 0));
    ctx.textBaseline = 'alphabetic';

    // 서빙 진행 바 (카운터 위 게이지)
    if (draining) {
      const bwid = laneW * 0.62;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      roundRect(gx - bwid / 2, gateY + 48, bwid, 7, 4); ctx.fill();
      ctx.fillStyle = SIZE_COL[game.drain.size].main;
      roundRect(gx - bwid / 2, gateY + 48, bwid * clamp(game.drain.progress, 0, 1), 7, 4); ctx.fill();
    }
    // 서빙 중 김 모락모락
    if (draining && Math.random() < 0.35) {
      suck(gx + rnd(-R * 0.5, R * 0.5), gateY - R * 0.7, gx, gateY - R * 2, 'rgba(255,250,235,');
    }
  }

  function drawCore() {
    const t = performance.now() / 1000;
    const beat = beatPhase();
    const pulse = Math.pow(1 - beat, 1.6);
    const R = 24 + Math.min(22, game.combo * 1.1) + pulse * 5 + feverGlow * 6;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 돈통 — 장사가 잘될수록(콤보) 환해짐
    const cg = ctx.createRadialGradient(W / 2, coreY, 2, W / 2, coreY, R * 2.4);
    const hue = 42 + Math.sin(t * 0.7) * 8 + feverGlow * 14;
    cg.addColorStop(0, `hsla(${hue}, 100%, 78%, 0.9)`);
    cg.addColorStop(0.35, `hsla(${hue}, 95%, 58%, 0.4)`);
    cg.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(W / 2, coreY, R * 2.4, 0, 7); ctx.fill();
    ctx.restore();
    ctx.font = `${Math.round(R * 0.95)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💰', W / 2, coreY + Math.sin(t * 2.6) * 2);
    ctx.textBaseline = 'alphabetic';
  }

  function drawParticles() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      const a = 1 - p.age / p.life;
      ctx.fillStyle = p.color + a * 0.9 + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (p.suck ? a : 1), 0, 7); ctx.fill();
    }
    for (const r of ripples) {
      const a = 1 - r.age / r.life;
      ctx.strokeStyle = r.color + a * 0.8 + ')';
      ctx.lineWidth = 2.5 * a;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 7); ctx.stroke();
    }
    ctx.restore();
    // 플로팅 텍스트
    for (const t of texts) {
      const a = 1 - Math.pow(t.age / t.life, 2);
      const sc = t.crit ? 1 + Math.sin(Math.min(1, t.age * 6) * Math.PI) * 0.35 : 1;
      ctx.save();
      ctx.translate(t.x, t.y); ctx.scale(sc, sc);
      ctx.font = `800 ${t.size}px -apple-system,sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4; ctx.strokeStyle = `rgba(10,8,30,${a * 0.9})`;
      ctx.strokeText(t.str, 0, 0);
      ctx.fillStyle = t.color;
      ctx.globalAlpha = a;
      ctx.fillText(t.str, 0, 0);
      ctx.restore();
    }
  }

  function drawHud() {
    ctx.textAlign = 'center';
    // 오늘 매출
    const s = Math.round(scoreShown);
    ctx.font = `800 ${Math.min(38, W * 0.085)}px -apple-system,sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(255,200,90,0.8)'; ctx.shadowBlur = 14;
    ctx.fillText(won(s), W / 2, 46);
    ctx.shadowBlur = 0;
    // 최고 매출
    ctx.font = '600 12px -apple-system,sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(`최고 매출 ${(best * MON).toLocaleString()}원`, W / 2, 64);
    // 연속 서빙 게이지
    if (game.combo >= 2 && mode === 'playing') {
      const mult = Core.comboMult(game.combo);
      const remain = clamp(1 - (game.t - game.lastDrainT) / C.COMBO_WINDOW, 0, 1);
      const bw = W * 0.4;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      roundRect(W / 2 - bw / 2, 72, bw, 6, 3); ctx.fill();
      ctx.fillStyle = feverGlow > 0.5 ? '#ffd166' : '#9dff8a';
      roundRect(W / 2 - bw / 2, 72, bw * remain, 6, 3); ctx.fill();
      ctx.font = '800 14px -apple-system,sans-serif';
      ctx.fillStyle = feverGlow > 0.5 ? '#ffd166' : '#9dff8a';
      ctx.fillText(`🔥 ${game.combo}연속 서빙  팁 ×${mult}`, W / 2, 96);
    }
  }

  function drawPaused() {
    ctx.fillStyle = 'rgba(5,5,20,0.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = '800 26px -apple-system,sans-serif';
    ctx.fillText('일시정지', W / 2, H / 2 - 10);
    ctx.font = '600 15px -apple-system,sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('탭해서 계속하기', W / 2, H / 2 + 22);
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ── DOM 연결 ──
  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('best-label').textContent = best > 0 ? `최고 매출 ${(best * MON).toLocaleString()}원` : '';

  // 음소거 토글
  const muteBtn = document.getElementById('btn-mute');
  function syncMute() { muteBtn.textContent = A.muted ? '🔇' : '🔊'; }
  muteBtn.addEventListener('click', () => { A.init(); A.setMuted(!A.muted); syncMute(); });
  syncMute();

  // 자랑하기 (cube 패턴)
  const SITE = 'https://junhee1219.github.io/gateway';
  const isMobile = () => /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const shareBtn = document.getElementById('btn-share');
  shareBtn.addEventListener('click', async () => {
    const score = game ? game.score : 0;
    const text = `🍜 라면집 매출 ${(score * MON).toLocaleString()}원! 나보다 장사 잘해봐 ㅋㅋ`;
    try {
      if (navigator.share && isMobile()) {
        await navigator.share({ title: '라면집 사장님', text, url: SITE });
      } else {
        await navigator.clipboard.writeText(`${text}\n${SITE}`);
        shareBtn.textContent = '✅ 복사 완료! 카톡에 붙여넣기';
        setTimeout(() => { shareBtn.textContent = '📤 친구에게 자랑하기'; }, 2000);
      }
    } catch (e) { /* 공유 취소 무시 */ }
  });

  // 간식 딥링크: PC에선 앱 스킴이 안 열리므로 "고마워요" 모달 (cube 패턴)
  const thanksModal = document.getElementById('thanks');
  document.getElementById('thanks-close').addEventListener('click', () => thanksModal.classList.add('hidden'));
  thanksModal.addEventListener('click', (e) => { if (e.target === thanksModal) thanksModal.classList.add('hidden'); });
  document.querySelectorAll('#snack a').forEach((a) => {
    a.addEventListener('click', (e) => {
      if (!isMobile()) { e.preventDefault(); thanksModal.classList.remove('hidden'); }
    });
  });

  // 서비스 워커 (localhost 개발 중엔 캐시 꼬임 방지를 위해 미등록)
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !/^(localhost|127\.)/.test(location.hostname)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }

  // QA 훅 (localhost 전용 — cube 패턴)
  if (/^(localhost|127\.)/.test(location.hostname)) {
    window.__gw = {
      get game() { return game; },
      get mode() { return mode; },
      start: startGame,
      setGate: (l) => Core.setGate(game, l),
      audioState: () => (A.ctx ? A.ctx.state : 'none'),
      audioSteps: () => A.steps, // 시퀀서 생존 카운터
    };
  }

  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('show-overlay');
  requestAnimationFrame(frame);
})();
