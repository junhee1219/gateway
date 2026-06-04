// GATEWAY — 합류 관문 코어 로직 (DOM 없음, node test.js로 테스트)
// 3개 레인에서 에너지 오브가 떨어지고, 게이트는 한 번에 한 레인만 배출한다.
// 레인이 넘치면 게임오버. 큰 오브는 점수가 높지만 통과가 느리다.

const CONF = {
  LANES: 3,
  CAP: 10,                 // 레인 용량 (유닛)
  TRANSIT: 0.22,           // 게이트 레인 이동 시간 (이동 중 배출 불가)
  FALL_TIME: 0.45,         // 스폰 → 큐 착지까지 (착지 순간 오버플로 판정)
  SIZES: {
    1: { score: 100, pass: 0.26 },  // S
    2: { score: 300, pass: 0.55 },  // M
    3: { score: 800, pass: 0.95 },  // L
  },
  PUMP: 0.16,              // 현재 레인 탭 1회당 배출 진행 보너스 (연타 = 가속)
  GOLD: { from: 8, chance: 0.07, life: 5.0, mult: 5 }, // 골드 오브: 5배, 착지 후 5초 내 못 빼면 증발
  COMBO_WINDOW: 2.5,       // 이 시간 안에 연속 배출하면 콤보 유지
  RESCUE_FILL: 0.8,        // 배출 시작 시 레인이 이 비율 이상이면 구사일생 x2
  SPAWN_START: 1.15,       // 초기 스폰 간격(초) — 시작부터 바쁘게
  SPAWN_MIN: 0.45,         // 최소 스폰 간격
  SPAWN_TAU: 35,           // 간격 감쇠 시정수 (풀압박 도달 ~50초)
  RAMP_T: 75,              // 크기 분포가 최종에 도달하는 시간
  WAVE_FROM: 12,           // 이 시간 이후 더블 스폰(딜레마) 발생
  WAVE_CHANCE: 0.3,        // 스폰마다 더블 스폰이 될 확률 (WAVE_FROM 이후)
};

// mulberry32 — 시드 고정 가능한 RNG (테스트 재현용)
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function comboMult(combo) {
  if (combo >= 20) return 3;
  if (combo >= 10) return 2;
  if (combo >= 5) return 1.5;
  return 1;
}

function spawnInterval(t) {
  return CONF.SPAWN_MIN + (CONF.SPAWN_START - CONF.SPAWN_MIN) * Math.exp(-t / CONF.SPAWN_TAU);
}

// 시간에 따른 크기 분포: 초반 S 위주 → 후반 L 증가
function sizeDist(t) {
  const r = Math.min(1, t / CONF.RAMP_T);
  return [0.70 - 0.30 * r, 0.25 + 0.10 * r, 0.05 + 0.20 * r]; // [S, M, L]
}

function createGame(seed = 1) {
  const g = {
    t: 0,
    rng: makeRng(seed),
    score: 0,
    combo: 0,
    maxCombo: 0,
    lastDrainT: -Infinity,
    lanes: Array.from({ length: CONF.LANES }, () => ({ queue: [], fill: 0 })),
    falling: [],            // { lane, size, timer } — 착지 전 오브
    gate: { lane: 1, x: 1, moving: false, from: 1, to: 1, progress: 0 },
    drain: null,            // { size, progress, pass, rescue }
    spawnTimer: 0.7,        // 첫 스폰까지 짧은 여유
    sameLaneStreak: { lane: -1, count: 0 },
    alive: true,
    overflowLane: -1,
    stats: { drained: 0, drainedUnits: 0, rescues: 0, switches: 0, aborts: 0, pumps: 0 },
    events: [],             // 렌더러/오디오가 프레임마다 소비
    nextId: 1,
  };
  // 한가한 첫 30초 제거: 레인 프리필 + 낙하 2개 — 시작 즉시 일감
  g.lanes[0].queue.push({ id: g.nextId++, size: 1 }); g.lanes[0].fill = 1;
  g.lanes[1].queue.push({ id: g.nextId++, size: 2 }); g.lanes[1].fill = 2;
  g.lanes[2].queue.push({ id: g.nextId++, size: 1 }); g.lanes[2].fill = 1;
  g.falling.push({ id: g.nextId++, lane: 1, size: 1, timer: 0.3 });
  g.falling.push({ id: g.nextId++, lane: 0, size: 1, timer: 0.6 });
  return g;
}

// 레인의 "예상" 채움 (착지 전 오브 포함) — 스폰 가중치/HUD 고스트 표시용
function projectedFill(g, lane) {
  let f = g.lanes[lane].fill;
  for (const o of g.falling) if (o.lane === lane) f += o.size;
  return f;
}

function dangerLevel(g) {
  let m = 0;
  for (let i = 0; i < CONF.LANES; i++) m = Math.max(m, projectedFill(g, i) / CONF.CAP);
  return Math.min(1, m);
}

function pickSize(g) {
  const [pS, pM] = sizeDist(g.t);
  const r = g.rng();
  return r < pS ? 1 : r < pS + pM ? 2 : 3;
}

function pickLane(g) {
  // 빈 레인 쪽에 약간 가중 (공정함) + 같은 레인 3연속 방지 (억울함 방지)
  const w = [];
  for (let i = 0; i < CONF.LANES; i++) {
    w.push(Math.pow(Math.max(0.5, CONF.CAP - projectedFill(g, i) + 1), 1.2));
  }
  const pick = () => {
    const sum = w[0] + w[1] + w[2];
    let r = g.rng() * sum;
    for (let i = 0; i < CONF.LANES; i++) { r -= w[i]; if (r <= 0) return i; }
    return CONF.LANES - 1;
  };
  let lane = pick();
  if (g.sameLaneStreak.lane === lane && g.sameLaneStreak.count >= 2) lane = pick(); // 1회 리롤
  if (g.sameLaneStreak.lane === lane) g.sameLaneStreak.count++;
  else g.sameLaneStreak = { lane, count: 1 };
  return lane;
}

function spawnOrb(g, lane, size, gold) {
  g.falling.push({ id: g.nextId++, lane, size, gold: !!gold, timer: CONF.FALL_TIME });
  g.events.push({ type: 'spawn', lane, size, gold: !!gold });
}

function doSpawn(g) {
  const lane = pickLane(g);
  let size = pickSize(g);
  // 골드 오브: S 크기, 5배 점수, 착지 후 제한시간 내 못 빼면 증발 — "지금 저 줄로?!" 유발
  let gold = false;
  if (g.t > CONF.GOLD.from && g.rng() < CONF.GOLD.chance) { size = 1; gold = true; }
  spawnOrb(g, lane, size, gold);
  // 딜레마 생성기: 가끔 다른 레인에 하나 더
  if (g.t > CONF.WAVE_FROM && g.rng() < CONF.WAVE_CHANCE) {
    const others = [0, 1, 2].filter((l) => l !== lane);
    const lane2 = others[g.rng() < 0.5 ? 0 : 1];
    spawnOrb(g, lane2, pickSize(g));
  }
}

// 게이트 이동/펌핑 요청 (사용자 입력). 이동 중 재타겟 허용.
function setGate(g, lane) {
  if (!g.alive) return false;
  if (lane < 0 || lane >= CONF.LANES) return false;
  const cur = g.gate.moving ? g.gate.to : g.gate.lane;
  if (lane === cur) {
    // 같은 레인 연타 = 펌핑: 배출 가속 (손이 쉬지 않게)
    if (g.drain && !g.gate.moving) {
      g.drain.progress += CONF.PUMP;
      g.stats.pumps++;
      g.events.push({ type: 'pump', lane });
      return true;
    }
    return false;
  }
  if (g.drain) { // 배출 중단 — 진행도 날아감 (전환 페널티)
    g.drain = null;
    g.stats.aborts++;
    g.events.push({ type: 'abort' });
  }
  g.gate.from = g.gate.x;
  g.gate.to = lane;
  g.gate.moving = true;
  g.gate.progress = 0;
  g.stats.switches++;
  g.events.push({ type: 'switch', to: lane });
  return true;
}

function update(g, dt) {
  if (!g.alive) return;
  g.t += dt;

  // ── 스폰 ──
  g.spawnTimer -= dt;
  if (g.spawnTimer <= 0) {
    doSpawn(g);
    g.spawnTimer += spawnInterval(g.t);
  }

  // ── 낙하 → 착지 (착지 순간 오버플로 판정: 떨어지는 동안 비우면 살 수 있다) ──
  for (let i = g.falling.length - 1; i >= 0; i--) {
    const o = g.falling[i];
    o.timer -= dt;
    if (o.timer <= 0) {
      g.falling.splice(i, 1);
      const lane = g.lanes[o.lane];
      if (lane.fill + o.size > CONF.CAP) {
        g.alive = false;
        g.overflowLane = o.lane;
        g.events.push({ type: 'overflow', lane: o.lane });
        return;
      }
      lane.fill += o.size;
      lane.queue.push({ id: o.id, size: o.size, gold: o.gold, expire: o.gold ? g.t + CONF.GOLD.life : 0 });
      g.events.push({ type: 'land', lane: o.lane, size: o.size, gold: !!o.gold });
    }
  }

  // ── 골드 오브 증발 (배출에 빨리는 중인 맨 아래 오브는 유예) ──
  for (let l = 0; l < CONF.LANES; l++) {
    const lane = g.lanes[l];
    for (let i = lane.queue.length - 1; i >= 0; i--) {
      const o = lane.queue[i];
      if (!o.gold || g.t < o.expire) continue;
      if (i === 0 && g.drain && !g.gate.moving && g.gate.lane === l) continue;
      lane.queue.splice(i, 1);
      lane.fill -= o.size;
      g.events.push({ type: 'goldLost', lane: l });
    }
  }

  // ── 게이트 이동 ──
  if (g.gate.moving) {
    g.gate.progress += dt / CONF.TRANSIT;
    if (g.gate.progress >= 1) {
      g.gate.moving = false;
      g.gate.lane = g.gate.to;
      g.gate.x = g.gate.to;
      g.events.push({ type: 'docked', lane: g.gate.lane });
    } else {
      const p = g.gate.progress;
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
      g.gate.x = g.gate.from + (g.gate.to - g.gate.from) * e;
    }
  }

  // ── 배출 ──
  if (!g.gate.moving) {
    const lane = g.lanes[g.gate.lane];
    if (!g.drain && lane.queue.length > 0) {
      const orb = lane.queue[0];
      g.drain = {
        size: orb.size,
        progress: 0,
        pass: CONF.SIZES[orb.size].pass,
        rescue: lane.fill / CONF.CAP >= CONF.RESCUE_FILL, // 시작 시점 기준
      };
      g.events.push({ type: 'drainStart', lane: g.gate.lane, size: orb.size, rescue: g.drain.rescue });
    }
    if (g.drain) {
      g.drain.progress += dt / g.drain.pass;
      if (g.drain.progress >= 1) {
        const orb = lane.queue.shift();
        lane.fill -= orb.size;
        // 콤보
        if (g.t - g.lastDrainT <= CONF.COMBO_WINDOW) g.combo++;
        else g.combo = 1;
        g.lastDrainT = g.t;
        g.maxCombo = Math.max(g.maxCombo, g.combo);
        const mult = comboMult(g.combo);
        const rescue = g.drain.rescue;
        const pts = Math.round(CONF.SIZES[orb.size].score * mult * (rescue ? 2 : 1) * (orb.gold ? CONF.GOLD.mult : 1));
        g.score += pts;
        g.stats.drained++;
        g.stats.drainedUnits += orb.size;
        if (rescue) g.stats.rescues++;
        g.events.push({
          type: 'drain', lane: g.gate.lane, size: orb.size,
          pts, combo: g.combo, mult, rescue, gold: !!orb.gold,
        });
        g.drain = null;
      }
    }
  }

  // 콤보 타임아웃
  if (g.combo > 0 && g.t - g.lastDrainT > CONF.COMBO_WINDOW) {
    g.combo = 0;
    g.events.push({ type: 'comboBreak' });
  }
}

// 이벤트 큐 비우기 (렌더러가 프레임마다 호출)
function drainEvents(g) {
  const ev = g.events;
  g.events = [];
  return ev;
}

const GatewayCore = {
  CONF, createGame, update, setGate, drainEvents,
  projectedFill, dangerLevel, comboMult, spawnInterval, sizeDist, makeRng,
};

if (typeof module !== 'undefined' && module.exports) module.exports = GatewayCore;
if (typeof window !== 'undefined') window.GatewayCore = GatewayCore;
