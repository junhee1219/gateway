// GATEWAY 코어 테스트 + 밸런스 시뮬레이션 — node test.js
// 대상: core.js (GatewayCore) — index.html이 로드하는 정본 코어
'use strict';
const Core = require('./core.js');
const { CONF, createGame, update, setGate, drainEvents, projectedFill, comboMult } = Core;

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

const DT = 1 / 120;
function run(g, sec) { for (let t = 0; t < sec; t += DT) update(g, DT); }

// 스폰 간섭 없이 수동 배치로 테스트하기 위한 준비 (프리필 포함 전부 제거)
function quiet(g) {
  g.spawnTimer = 9999;
  g.falling.length = 0;
  g.lanes.forEach((l) => { l.queue.length = 0; l.fill = 0; });
  g.drain = null;
}

// ───────────────────────── 단위 테스트 ─────────────────────────
console.log('\n[1] 시작 흐름: 스타터 오브가 떨어지고 게이트가 배출한다');
{
  const g = createGame(7);
  run(g, 1.2);
  const ev = drainEvents(g);
  assert(ev.some((e) => e.type === 'land'), '착지 이벤트 발생');
  assert(g.stats.drained >= 1, `시작 1.2초 안에 첫 배출 (${g.stats.drained}개)`);
  assert(g.alive, '초반 생존');
}

console.log('\n[2] 배출: 통과시간 후 점수 적립');
{
  const g = createGame(1);
  quiet(g);
  g.lanes[1].queue.push({ id: 99, size: 2 });
  g.lanes[1].fill = 2;
  let t = 0;
  while (g.stats.drained === 0 && t < 2) { update(g, DT); t += DT; }
  assert(g.stats.drained === 1, 'M 오브 1개 배출');
  assert(Math.abs(t - CONF.SIZES[2].pass) < 0.1, `통과 시간 ≈ ${CONF.SIZES[2].pass}s (실제 ${t.toFixed(2)}s)`);
  assert(g.score === CONF.SIZES[2].score, `점수 ${CONF.SIZES[2].score}점 (콤보 1 = x1)`);
  assert(g.lanes[1].fill === 0, '배출 후 fill 감소');
}

console.log('\n[3] 구사일생(RESCUE): 80%+ 찬 레인에서 배출 시작하면 2배');
{
  const g = createGame(1);
  quiet(g);
  for (let i = 0; i < 8; i++) g.lanes[1].queue.push({ id: i, size: 1 });
  g.lanes[1].fill = 8; // 8/10 = 80%
  let t = 0;
  while (g.stats.drained === 0 && t < 2) { update(g, DT); t += DT; }
  const ev = drainEvents(g);
  const d = ev.filter((e) => e.type === 'drain')[0];
  assert(d && d.rescue === true, 'rescue 판정 (배출 시작 시점 기준)');
  assert(d.pts === CONF.SIZES[1].score * 2, `점수 2배 (${d.pts}점)`);
  assert(g.stats.rescues === 1, 'rescue 통계 기록');
}

console.log('\n[4] 콤보: 윈도 안에 연속 배출 → x1.5(5), x2(10) / 끊기면 리셋');
{
  const g = createGame(1);
  quiet(g);
  for (let i = 0; i < 10; i++) g.lanes[1].queue.push({ id: i, size: 1 });
  g.lanes[1].fill = 10;
  run(g, 5); // S 10개 연속 배출 — 콤보 윈도 내
  const drains = drainEvents(g).filter((e) => e.type === 'drain');
  assert(drains.length === 10, '10개 연속 배출');
  assert(drains[4].mult === comboMult(5), `5콤보째 배율 ${drains[4].mult} = ${comboMult(5)}`);
  assert(drains[9].mult === comboMult(10), `10콤보째 배율 ${drains[9].mult} = ${comboMult(10)}`);
  assert(g.maxCombo === 10, '최대 콤보 기록');
  run(g, 3.5); // 큐 비어서 3초 초과 → 콤보 브레이크
  assert(g.combo === 0, '윈도 초과 시 콤보 리셋');
  assert(drainEvents(g).some((e) => e.type === 'comboBreak'), 'comboBreak 이벤트');
}

console.log('\n[5] 오버플로: 착지 순간 용량 초과 → 게임오버');
{
  const g = createGame(1);
  quiet(g);
  for (let i = 0; i < 10; i++) g.lanes[0].queue.push({ id: i, size: 1 });
  g.lanes[0].fill = 10; // 게이트(1번)가 못 비우는 0번 레인 만석
  g.falling.push({ id: 99, lane: 0, size: 1, timer: 0.02 });
  run(g, 0.1);
  assert(!g.alive, '오버플로 → 사망');
  assert(g.overflowLane === 0, '오버플로 레인 기록');
  assert(drainEvents(g).some((e) => e.type === 'overflow'), 'overflow 이벤트');
}

console.log('\n[6] 게이트 전환: 이동/도킹/중복요청 무시/배출 중단 페널티');
{
  const g = createGame(1);
  quiet(g);
  assert(setGate(g, 1) === false, '현재 레인 재요청 → 무시');
  assert(setGate(g, 0) === true, '다른 레인 요청 → 수락');
  assert(g.gate.moving === true, '이동 시작');
  assert(setGate(g, 0) === false, '같은 목적지 재요청 → 무시');
  let t = 0;
  while (g.gate.moving && t < 1) { update(g, DT); t += DT; }
  assert(g.gate.lane === 0, '도킹 완료');
  assert(Math.abs(t - CONF.TRANSIT) < 0.05, `이동 시간 ≈ ${CONF.TRANSIT}s (실제 ${t.toFixed(2)}s)`);
  drainEvents(g);
  // 배출 중단 페널티
  g.lanes[0].queue.push({ id: 9, size: 3 });
  g.lanes[0].fill = 3;
  run(g, 0.5); // L 오브 절반쯤
  assert(g.drain && g.drain.progress > 0.2, 'L 오브 배출 진행 중');
  setGate(g, 2);
  assert(g.drain === null, '전환 시 배출 취소 (진행도 소실)');
  assert(g.stats.aborts === 1, 'abort 통계 기록');
  assert(g.lanes[0].queue.length === 1 && g.lanes[0].fill === 3, '오브와 fill은 그대로');
}

console.log('\n[6.5] 펌핑: 배출 중 같은 레인 연타 = 가속');
{
  const g = createGame(1);
  quiet(g);
  g.lanes[1].queue.push({ id: 9, size: 3 });
  g.lanes[1].fill = 3;
  run(g, 0.1); // 배출 시작
  drainEvents(g);
  const p0 = g.drain.progress;
  assert(setGate(g, 1) === true, '배출 중 같은 레인 탭 → 펌프 수락');
  assert(g.drain.progress >= p0 + CONF.PUMP * 0.99, `진행도 +${CONF.PUMP} 점프`);
  assert(g.stats.pumps === 1, 'pump 통계 기록');
  assert(drainEvents(g).some((e) => e.type === 'pump'), 'pump 이벤트');
  for (let i = 0; i < 8; i++) setGate(g, 1); // 연타
  run(g, 0.05);
  assert(g.stats.drained === 1, '연타로 L 오브 조기 배출 완료');
  assert(setGate(g, 1) === false, '배출 대상 없으면 같은 레인 탭 무시');
}

console.log('\n[6.7] 골드: 5배 점수 / 방치하면 증발');
{
  const g = createGame(1);
  quiet(g);
  // 게이트(1번)가 닿지 않는 0번 레인에 골드 방치 → 증발
  g.lanes[0].queue.push({ id: 9, size: 1, gold: true, expire: g.t + 0.5 });
  g.lanes[0].fill = 1;
  run(g, 1);
  assert(g.lanes[0].queue.length === 0 && g.lanes[0].fill === 0, '골드 증발 → 큐/fill 정리');
  assert(drainEvents(g).some((e) => e.type === 'goldLost'), 'goldLost 이벤트');
  // 게이트 레인의 골드는 배출되며 5배
  const g2 = createGame(1);
  quiet(g2);
  g2.lanes[1].queue.push({ id: 9, size: 1, gold: true, expire: g2.t + 9 });
  g2.lanes[1].fill = 1;
  run(g2, 0.5);
  const d = drainEvents(g2).find((e) => e.type === 'drain');
  assert(d && d.gold === true, '골드 배출 이벤트');
  assert(d.pts === CONF.SIZES[1].score * CONF.GOLD.mult, `골드 ${CONF.GOLD.mult}배 (${d && d.pts}점)`);
}

console.log('\n[7] 결정론: 같은 시드 → 같은 결과');
{
  const snap = (seed) => {
    const g = createGame(seed);
    for (let t = 0; t < 30; t += DT) { update(g, DT); g.events.length = 0; }
    return `${g.score}|${g.stats.drained}|${g.t.toFixed(3)}`;
  };
  assert(snap(42) === snap(42), '시드 42 두 번 실행 동일');
  assert(snap(42) !== snap(43), '다른 시드는 다른 전개');
}

// ───────────────────────── 밸런스 봇 시뮬레이션 ─────────────────────────
// 봇이 영원히 살면 자명한 전략 존재(설계 실패), 즉사하면 불공정.
function runBot(seed, decide, maxT, pumpEvery) {
  const g = createGame(seed);
  let decideTimer = 0, pumpTimer = 0;
  while (g.alive && g.t < maxT) {
    update(g, DT);
    g.events.length = 0;
    decideTimer -= DT;
    pumpTimer -= DT;
    if (decideTimer <= 0) {
      decideTimer = 0.12; // 인간급 판단 주기
      const target = decide(g);
      if (target >= 0) setGate(g, target);
    }
    // 펌핑: 배출 중이면 주기적으로 현재 레인 연타 (사람 흉내)
    if (pumpEvery && pumpTimer <= 0 && g.drain && !g.gate.moving) {
      setGate(g, g.gate.lane);
      pumpTimer = pumpEvery;
    }
  }
  return { t: g.t, score: g.score, drained: g.stats.drained };
}

// 탐욕 봇: 무조건 제일 찬 레인 (감사가 경고한 "자명한 전략" — 너무 잘 살면 설계 실패)
const greedy = (g) => {
  let best = -1, bestF = -1;
  for (let i = 0; i < CONF.LANES; i++) {
    const f = projectedFill(g, i);
    if (f > bestF) { bestF = f; best = i; }
  }
  return best;
};

// 스마트 봇: 낙하 압력 포함 + 매몰비용(거의 끝난 배출은 마무리) + 히스테리시스
const smart = (g) => {
  const cur = g.gate.moving ? g.gate.to : g.gate.lane;
  let best = -1, bestP = -1;
  for (let i = 0; i < CONF.LANES; i++) {
    const p = projectedFill(g, i);
    if (p > bestP) { bestP = p; best = i; }
  }
  if (best === cur) return -1;
  const curP = projectedFill(g, cur);
  if (g.drain && g.drain.progress > 0.55 && bestP < CONF.CAP * 0.85) return -1;
  if (bestP - curP < 1.5 && bestP < CONF.CAP * 0.8) return -1;
  return best;
};

const idle = () => -1;

console.log('\n[8] 밸런스 시뮬레이션 (20시드)');
{
  const stats = (bot, pumpEvery) => {
    const rs = [];
    for (let s = 1; s <= 20; s++) rs.push(runBot(s * 1000 + 7, bot, 600, pumpEvery));
    rs.sort((a, b) => a.t - b.t);
    return { med: rs[10], max: rs[rs.length - 1], maxScore: Math.max(...rs.map((r) => r.score)) };
  };
  const bi = stats(idle, 0);             // 방치: 입력 없음
  const bg = stats(greedy, 0.45);        // 탐욕: 대충 펌핑
  const bs = stats(smart, 0.22);         // 스마트: 열심히 펌핑 (~4.5타/초)
  console.log(`  방치 봇:   중앙 생존 ${bi.med.t.toFixed(1)}s`);
  console.log(`  탐욕 봇:   중앙 생존 ${bg.med.t.toFixed(1)}s · 최장 ${bg.max.t.toFixed(1)}s · 최고 ${bg.maxScore}점`);
  console.log(`  스마트 봇: 중앙 생존 ${bs.med.t.toFixed(1)}s · 최장 ${bs.max.t.toFixed(1)}s · 최고 ${bs.maxScore}점`);
  assert(bi.med.t < 35, '방치하면 35초 내 사망 (시작부터 압박)');
  assert(bg.med.t < 240, '탐욕 전략은 4분을 못 버틴다 (자명한 전략 차단)');
  assert(bs.med.t > 40, '스마트 전략은 40초 이상 (불공정 아님)');
  assert(bs.max.t < 600, '아무도 영생 불가 (램프가 결국 이긴다)');
  assert(bs.med.t > bg.med.t * 0.9, '머리 쓰는 쪽이 손해 보지 않는다');
  console.log(`\n  → 커피 이스터에그 기준 참고: 스마트봇 최고 ${bs.maxScore}점 (사람 고수는 콤보/골드로 이를 상회 가능)`);
}

console.log(failed === 0 ? '\n✅ 전체 통과' : `\n❌ ${failed}개 실패`);
process.exit(failed === 0 ? 0 : 1);
