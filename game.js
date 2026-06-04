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
  let stars = [];
  function initStars() {
    stars = [];
    for (let L = 0; L < 3; L++) {
      const n = [50, 32, 18][L];
      for (let i = 0; i < n; i++) {
        stars.push({ x: Math.random() * W, y: Math.random() * H, L, tw: Math.random() * Math.PI * 2 });
      }
    }
  }

  // ── 상태 ──
  let mode = 'menu';           // menu | playing | over
  let game = null;
  let paused = false;
  let visOrbs = new Map();     // id → 시각 상태
  let drainVis = null;         // 배출 중 오브 시각 상태
  let particles = [], texts = [], ripples = [];
  let shake = 0, flash = 0, flashColor = '255,255,255', redPulse = 0;
  let timeScale = 1, slowmoT = 0;
  let lastWarnT = -9, prevMult = 1, feverGlow = 0;
  let scoreShown = 0;          // 점수 롤링
  let hueShift = 0;
  let overflowFx = null;       // { lane, t }
  let best = +localStorage.getItem('gatewayBest') || 0;

  const LCOL = [
    { main: '#27e8ff', glow: 'rgba(39,232,255,', mid: '#0e7c97' },   // cyan
    { main: '#c47bff', glow: 'rgba(196,123,255,', mid: '#6b2fa3' },  // violet
    { main: '#ffb347', glow: 'rgba(255,179,71,', mid: '#a35e0e' },   // amber
  ];
  const SIZE_R = { 1: 0.16, 2: 0.23, 3: 0.30 }; // 반지름 = laneW * 비율
  const SIZE_COL = {
    1: { main: '#6ef3ff', glow: 'rgba(110,243,255,' },
    2: { main: '#d49bff', glow: 'rgba(212,155,255,' },
    3: { main: '#ffd166', glow: 'rgba(255,209,102,' },
  };

  // ── 유틸 ──
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const rnd = (a, b) => a + Math.random() * (b - a);
  function vibrate(ms) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (e) {} }
  function beatPhase() { // 110BPM 4분음표 위상 (0~1) — 비트 동기 펄스
    if (A.ctx) return (A.ctx.currentTime % (60 / 110)) / (60 / 110);
    return (performance.now() / 1000 % (60 / 110)) / (60 / 110);
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
        case 'docked': {
          A.dock();
          shock(laneCenter(ev.lane), gateY, LCOL[ev.lane].glow, 40);
          break;
        }
        case 'drainStart': break;
        case 'drain': {
          const col = SIZE_COL[ev.size];
          const n = ev.size === 3 ? 26 : ev.size === 2 ? 16 : 10;
          burst(cx, gateY, col.glow, n, 170 + ev.size * 40, 0.55, 3.5);
          shock(cx, gateY, col.glow, 60 + ev.size * 18);
          shake = Math.max(shake, ev.size === 3 ? 7 : ev.size === 2 ? 4 : 2);
          addText(cx, gateY - 46, `+${ev.pts}`, ev.rescue ? '#ffe16b' : col.main,
            16 + ev.size * 4 + (ev.mult > 1 ? 4 : 0), ev.rescue);
          if (ev.rescue) {
            addText(cx, gateY - 78, '구사일생! ×2', '#ffe16b', 17, true);
            flash = Math.max(flash, 0.25); flashColor = '255,225,107';
          }
          const mult = Core.comboMult(ev.combo);
          if (mult > prevMult) {
            A.comboUp(mult >= 3 ? 2 : mult >= 2 ? 1 : 0);
            addText(W / 2, H * 0.30, `콤보 ×${mult}`, '#7dffb1', 26, true);
            shock(W / 2, H * 0.30, 'rgba(125,255,177,', 90);
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
  const COFFEE = 15000; // 커피 이스터에그 점수 (되게 넘기 힘든 점수 — test.js 봇 기준 검증)
  function deathMessage(score) {
    if (score >= COFFEE) return {
      e: '🏆', t: '전설의 게이트 마스터!',
      m: `<b>${score.toLocaleString()}점</b>?! 이건 개발자도 못 깬 기록이에요.<br>너무 고수라서 개발자가 커피 한 잔 사겠습니다 ☕<br><a href="mailto:junhee@finda.co.kr">junhee@finda.co.kr</a> 로 연락 주세요!`,
    };
    if (score >= 8000) return {
      e: '👑', t: '수석 관제사',
      m: `<b>${score.toLocaleString()}점</b>! 관문이 당신을 신뢰하기 시작했어요.<br>${COFFEE.toLocaleString()}점을 넘기면 좋은 일이 생긴다는 소문이...`,
    };
    if (score >= 4000) return {
      e: '🔥', t: '베테랑 관제사',
      m: `<b>${score.toLocaleString()}점</b>! 세 레인을 동시에 읽는 눈,<br>예사롭지 않은데요?`,
    };
    if (score >= 1500) return {
      e: '🚦', t: '정식 관제사 승급!',
      m: `<b>${score.toLocaleString()}점</b>! 이제 관문이<br>슬슬 만만해 보이기 시작했죠?`,
    };
    if (score >= 400) return {
      e: '🍀', t: '견습 관제사',
      m: `<b>${score.toLocaleString()}점</b>! 몸풀기는 끝.<br>큰 오브(80점)를 노려보세요`,
    };
    if (score >= 1) return {
      e: '🌱', t: '관제 연수생',
      m: `<b>${score}점</b>! 게이트는 탭한 레인으로 움직여요.<br>가득 찬 레인부터 비워봐요`,
    };
    return { e: '🥚', t: '음...', m: '오브는 장식이 아니에요! 🥲<br>레인을 탭해서 게이트를 옮겨봐요' };
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
      (isRecord ? '<span class="newrecord">🎉 NEW RECORD! 🎉</span><br>' : '') + m +
      (game.maxCombo >= 5 ? `<br><span class="sub">최대 콤보 🔥x${game.maxCombo} · 오브 ${game.stats.drained}개 · 구사일생 ${game.stats.rescues}회</span>` : '');
    document.getElementById('btn-start').textContent = '다시 하기!';
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
      A.setIntensity(Core.dangerLevel(game) * 0.85 + Math.min(0.3, game.combo * 0.015));
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
          v.lane = l; v.r = r;
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
        if (!v) { v = { x: laneCenter(o.lane), y, vy: 0, r: laneW * SIZE_R[o.size], size: o.size, lane: o.lane, ph: Math.random() * 7, falling: true }; visOrbs.set(o.id, v); }
        v.y = y; v.falling = true;
        if (Math.random() < 0.5) suck(v.x, v.y - 8, v.x, v.y - 26, SIZE_COL[o.size].glow); // 트레일
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
    const pulse = Math.pow(1 - beat, 2) * 0.06; // 비트마다 살짝 밝아짐
    const g = ctx.createLinearGradient(0, 0, 0, H);
    const fv = feverGlow;
    g.addColorStop(0, `hsl(${248 + Math.sin(hueShift / 50) * 10 + fv * 40}, 45%, ${7 + pulse * 30}%)`);
    g.addColorStop(0.7, `hsl(${262 + fv * 50}, 50%, ${10 + pulse * 40}%)`);
    g.addColorStop(1, `hsl(${280 + fv * 60}, 55%, ${13 + pulse * 50}%)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // 별 (3층 패럴랙스 — 아래로 흐름)
    const t = performance.now() / 1000;
    for (const s of stars) {
      const sp = [6, 13, 26][s.L];
      const y = (s.y + t * sp) % H;
      const a = 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2 + s.tw)) * (s.L + 1) / 3;
      ctx.fillStyle = `rgba(200,220,255,${a})`;
      const r = (s.L + 1) * 0.7;
      ctx.fillRect(s.x, y, r, r);
    }

    // 신스웨이브 바닥 그리드 (코어 소실점)
    ctx.save();
    ctx.globalAlpha = 0.16 + pulse * 1.6 + fv * 0.1;
    ctx.strokeStyle = '#7d4dff';
    ctx.lineWidth = 1;
    const vy = coreY, vx = W / 2;
    for (let i = -5; i <= 5; i++) {
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(vx + i * W * 0.22, H + 40);
      ctx.stroke();
    }
    const scroll = (t * 0.7) % 1;
    for (let i = 0; i < 5; i++) {
      const p = Math.pow((i + scroll) / 5, 1.8);
      const y = vy + p * (H - vy + 40);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawLanes() {
    for (let l = 0; l < 3; l++) {
      const x = laneX[l], cx = laneCenter(l);
      const fill = game.lanes[l].fill / C.CAP;
      const proj = Core.projectedFill(game, l) / C.CAP;
      const col = LCOL[l];
      const hot = fill >= 0.8;
      const alarm = hot ? 0.5 + 0.5 * Math.sin(performance.now() / 90) : 0;

      // 튜브 배경
      ctx.fillStyle = 'rgba(8,10,30,0.55)';
      roundRect(x + 4, tubeTop - 8, laneW - 8, tubeBot - tubeTop + 16, 14);
      ctx.fill();

      // 압력 글로우 (바닥에서 차오름)
      const fy = tubeBot - fill * (tubeBot - tubeTop);
      const grad = ctx.createLinearGradient(0, tubeBot, 0, fy);
      grad.addColorStop(0, col.glow + (0.30 + alarm * 0.3) + ')');
      grad.addColorStop(1, col.glow + '0.04)');
      ctx.fillStyle = grad;
      roundRect(x + 4, fy, laneW - 8, tubeBot - fy + 8, 10);
      ctx.fill();

      // 고스트 (낙하 중 포함 예상 압력)
      if (proj > fill) {
        const py = tubeBot - proj * (tubeBot - tubeTop);
        ctx.fillStyle = col.glow + '0.07)';
        roundRect(x + 4, py, laneW - 8, fy - py, 8);
        ctx.fill();
      }

      // 네온 테두리
      ctx.strokeStyle = hot ? `rgba(255,80,80,${0.55 + alarm * 0.45})` : col.glow + (l === currentGateLane() ? '0.8)' : '0.30)');
      ctx.lineWidth = l === currentGateLane() ? 2.5 : 1.5;
      roundRect(x + 4, tubeTop - 8, laneW - 8, tubeBot - tubeTop + 16, 14);
      ctx.stroke();

      // 용량 눈금
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      for (let u = 1; u < C.CAP; u++) {
        const y = tubeBot - u * unitH;
        ctx.beginPath(); ctx.moveTo(x + 10, y); ctx.lineTo(x + laneW - 10, y); ctx.stroke();
      }

      // % 라벨 (튜브 안쪽 상단 — 콤보 HUD와 겹치지 않게)
      const pct = Math.round(proj * 100);
      ctx.font = `bold ${hot ? 15 : 12}px -apple-system,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = hot ? `rgba(255,${120 - alarm * 60},${120 - alarm * 60},0.95)` : 'rgba(255,255,255,0.45)';
      ctx.fillText((hot ? '⚠ ' : '') + pct + '%', cx, tubeTop + 12);
    }
  }

  function currentGateLane() { return game.gate.moving ? -1 : game.gate.lane; }

  function drawOrbs() {
    ctx.save();
    const t = performance.now() / 1000;
    for (const v of visOrbs.values()) {
      const col = SIZE_COL[v.size];
      const wob = Math.sin(t * 3 + v.ph) * 1.5;
      drawOrb(v.x, v.y + wob, v.r, col, v.size, t + v.ph);
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
          ctx.scale(sq, 1 + p * 0.55); // 늘어나며 빨려듦
          drawOrb(0, 0, v.r, SIZE_COL[v.size], v.size, performance.now() / 1000);
          ctx.restore();
        }
      }
    }
  }

  function drawOrb(x, y, r, col, size, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 할로
    const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 2.2);
    g.addColorStop(0, col.glow + '0.5)');
    g.addColorStop(1, col.glow + '0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 7); ctx.fill();
    // 본체
    const g2 = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    g2.addColorStop(0, '#ffffff');
    g2.addColorStop(0.35, col.main);
    g2.addColorStop(1, col.glow + '0.25)');
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    // 회전 에너지 링
    ctx.strokeStyle = col.glow + '0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.15, r * 0.4, (t * 1.7) % 7, 0, 7);
    ctx.stroke();
    if (size === 3) { // L 오브: 링 하나 더 + 점수 암시
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.3, r * 0.5, (-t * 1.2) % 7, 0, 7);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawGate() {
    const gx = laneX[0] + laneW / 2 + game.gate.x * laneW;
    const t = performance.now() / 1000;
    const draining = game.drain && !game.gate.moving;
    const R = laneW * 0.34;
    ctx.save();
    // 게이트 → 코어 빔
    if (draining) {
      const col = SIZE_COL[game.drain.size];
      ctx.globalCompositeOperation = 'lighter';
      const bg = ctx.createLinearGradient(0, gateY, 0, coreY);
      bg.addColorStop(0, col.glow + '0.55)');
      bg.addColorStop(1, col.glow + '0.05)');
      ctx.fillStyle = bg;
      const bw = 7 + Math.sin(t * 30) * 2 + game.drain.size * 2;
      ctx.beginPath();
      ctx.moveTo(gx - bw, gateY); ctx.lineTo(gx + bw, gateY);
      ctx.lineTo(W / 2 + bw * 0.6, coreY); ctx.lineTo(W / 2 - bw * 0.6, coreY);
      ctx.fill();
    }
    // 링
    ctx.globalCompositeOperation = 'lighter';
    const spin = t * (draining ? 6 : 1.6);
    const col = game.gate.moving ? 'rgba(255,255,255,' : LCOL[clamp(Math.round(game.gate.x), 0, 2)].glow;
    const hg = ctx.createRadialGradient(gx, gateY, R * 0.3, gx, gateY, R * 2);
    hg.addColorStop(0, col + '0.35)');
    hg.addColorStop(1, col + '0)');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(gx, gateY, R * 2, 0, 7); ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = col + '0.95)';
    ctx.setLineDash([10, 7]);
    ctx.lineDashOffset = -spin * 22;
    ctx.beginPath(); ctx.arc(gx, gateY, R, 0, 7); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = col + '0.5)';
    ctx.beginPath(); ctx.arc(gx, gateY, R * 0.68, 0, 7); ctx.stroke();
    // 배출 진행 호
    if (draining) {
      ctx.lineWidth = 4.5;
      ctx.strokeStyle = SIZE_COL[game.drain.size].main;
      ctx.beginPath();
      ctx.arc(gx, gateY, R + 7, -Math.PI / 2, -Math.PI / 2 + game.drain.progress * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCore() {
    const t = performance.now() / 1000;
    const beat = beatPhase();
    const pulse = Math.pow(1 - beat, 1.6);
    const R = 26 + Math.min(24, game.combo * 1.2) + pulse * 5 + feverGlow * 6;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const cg = ctx.createRadialGradient(W / 2, coreY, 2, W / 2, coreY, R * 2.6);
    const hue = 190 + Math.sin(t * 0.7) * 25 + feverGlow * 100;
    cg.addColorStop(0, `hsla(${hue}, 100%, 80%, 0.95)`);
    cg.addColorStop(0.35, `hsla(${hue}, 95%, 60%, 0.45)`);
    cg.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(W / 2, coreY, R * 2.6, 0, 7); ctx.fill();
    ctx.restore();
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
    // 점수
    const s = Math.round(scoreShown);
    ctx.font = `800 ${Math.min(40, W * 0.09)}px -apple-system,sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(120,180,255,0.8)'; ctx.shadowBlur = 14;
    ctx.fillText(s.toLocaleString(), W / 2, 46);
    ctx.shadowBlur = 0;
    // 베스트
    ctx.font = '600 12px -apple-system,sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(`BEST ${best.toLocaleString()}`, W / 2, 64);
    // 콤보 게이지
    if (game.combo >= 2 && mode === 'playing') {
      const mult = Core.comboMult(game.combo);
      const remain = clamp(1 - (game.t - game.lastDrainT) / C.COMBO_WINDOW, 0, 1);
      const bw = W * 0.4;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      roundRect(W / 2 - bw / 2, 72, bw, 6, 3); ctx.fill();
      ctx.fillStyle = feverGlow > 0.5 ? '#ffd166' : '#7dffb1';
      roundRect(W / 2 - bw / 2, 72, bw * remain, 6, 3); ctx.fill();
      ctx.font = '800 14px -apple-system,sans-serif';
      ctx.fillStyle = feverGlow > 0.5 ? '#ffd166' : '#7dffb1';
      ctx.fillText(`🔥 ${game.combo} COMBO  ×${mult}`, W / 2, 96);
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
  document.getElementById('best-label').textContent = best > 0 ? `최고 기록 ${best.toLocaleString()}점` : '';

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
    const text = `🚦 GATEWAY ${score.toLocaleString()}점! 세 레인 동시에 막아봐 ㅋㅋ`;
    try {
      if (navigator.share && isMobile()) {
        await navigator.share({ title: 'GATEWAY', text, url: SITE });
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
    };
  }

  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('show-overlay');
  requestAnimationFrame(frame);
})();
