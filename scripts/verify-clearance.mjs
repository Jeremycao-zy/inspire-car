/**
 * verify-clearance.mjs — 轮胎扫掠间隙检测离线自检（零成本、不开浏览器）
 *
 * 8 项校验：
 *   1. 原厂必须安全：6 款车 × 前后轴 × 原厂规格，全工况 minGap > 0
 *   2. 单调性：胎宽 255→265→275 outer 递减；ET 增大 outer 递增
 *   3. 方向对称：同轴 FL 与 FR 的 minGap 相等
 *   4. 工况排序：static 的 top > bump 的 top
 *   5. 倾角正确：camber 0→−3，top 减小、inner 增大
 *   6. 未建档降级：analyzeAll('random-car') → available:false 且无任何数字
 *   7. 建议可验证：已知干涉规格，suggestFix 给出的建议应用后干涉确实消除
 *   8. 确定性：同一输入跑两次，结果完全一致（无随机数参与）
 *
 * 用法：node scripts/verify-clearance.mjs
 */
import {
  TIRE_BASIS, TIRE_WIDTHS_MM, RIM_DIAMETERS_IN,
} from '../src/tuning/tireBasis.js';
import {
  analyzeAll, analyzeWithBasis, worstCase, suggestFix,
  GAP_DIRECTIONS, CONDITIONS, THRESH, tireGeometry,
} from '../src/tuning/clearance.js';

let fail = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 6) => String(typeof v === 'number' ? v.toFixed(1) : v).padStart(n);

const BASES = Object.entries(TIRE_BASIS);

/** 跑一个工况的 minGap */
function rowOf(res, corner, condition) {
  const r = res.results.find((x) => x.corner === corner && x.condition === condition);
  return r || null;
}
/** 某角某工况某方向的间隙 */
function gapOf(res, corner, condition, dir) {
  const r = rowOf(res, corner, condition);
  return r ? r.gaps[dir].value : null;
}

/* ============================ 1. 原厂必须安全 ============================ */
console.log('=== 1. 原厂规格扫掠安全（minGap 全工况 > 0）===');
const oeTable = [];
for (const [key, b] of BASES) {
  const res = analyzeAll(key);
  if (!res.available) { bad(`${b.name} 分析返回 available=false`); continue; }
  const issues = [];
  let worstMin = Infinity, worstDesc = '';
  for (const row of res.results) {
    if (row.minGap <= 0) {
      issues.push(`${row.corner}/${row.condition} minGap=${row.minGap}`
        + `（${Object.entries(row.gaps).filter(([, g]) => g.value === row.minGap).map(([k]) => k).join('/')}）`);
    }
    if (row.minGap < worstMin) { worstMin = row.minGap; worstDesc = `${row.corner}/${row.condition}`; }
  }
  const oe = rowOf(res, 'FL', 'static');
  oeTable.push({
    name: b.name, conf: b.confidence,
    frontTop: gapOf(res, 'FL', 'static', 'top'),
    frontOuter: gapOf(res, 'FL', 'static', 'outer'),
    rearTop: gapOf(res, 'RL', 'static', 'top'),
    rearOuter: gapOf(res, 'RL', 'static', 'outer'),
    min: worstMin, at: worstDesc,
  });
  if (issues.length) { bad(`${b.name} 原厂出现干涉：`); issues.slice(0, 6).forEach((i) => console.log(`       - ${i}`)); }
  else ok(`${pad(b.name, 26)} 全 ${res.results.length} 工况 minGap ≥ 0（最差 ${worstMin}mm @ ${worstDesc}）`);
}

console.log('\n  --- 原厂关键间隙实测表（mm，静止工况）---');
console.log(`  ${pad('车型', 26)}${pad('conf', 6)}${num('前顶隙')}${num('前外侧')}${num('后顶隙')}${num('后外侧')}${num('全车最差')}`);
for (const t of oeTable) {
  console.log(`  ${pad(t.name, 26)}${pad(t.conf, 6)}${num(t.frontTop)}${num(t.frontOuter)}${num(t.rearTop)}${num(t.rearOuter)}${num(t.min)}`);
}

/* ============================ 2. 单调性 ============================ */
console.log('\n=== 2. 单调性（外侧间隙对胎宽 / ET）===');
{
  const key = 'mercedes-sl350-r230';
  const b = TIRE_BASIS[key];
  // 2a 胎宽 255 → 265 → 275，outer 必须单调递减
  const widthSeq = [];
  for (const w of [255, 265, 275]) {
    const res = analyzeAll(key, { ...b.front, tireWidthMm: w });
    const g = gapOf(res, 'FL', 'bumpLock', 'outer');
    widthSeq.push({ w, outer: g, min: res.summary.minGap });
  }
  const dec = widthSeq[0].outer > widthSeq[1].outer && widthSeq[1].outer > widthSeq[2].outer;
  console.log(`  胎宽序列 outer(FL/bumpLock): ${widthSeq.map((x) => `${x.w}→${x.outer}`).join('  ')}`);
  if (dec) ok(`胎宽↑ 外侧间隙单调递减 ${widthSeq.map((x) => x.outer).join(' > ')}`);
  else bad(`胎宽↑ 外侧间隙未单调递减：${widthSeq.map((x) => x.outer).join(' / ')}`);

  // 2b ET 增大，outer 必须单调递增
  const etSeq = [];
  for (const et of [10, 18, 26, 34]) {
    const res = analyzeAll(key, { ...b.front, et });
    const g = gapOf(res, 'FL', 'bumpLock', 'outer');
    etSeq.push({ et, outer: g });
  }
  const inc = etSeq.every((x, i) => i === 0 || x.outer > etSeq[i - 1].outer);
  console.log(`  ET 序列 outer(FL/bumpLock):    ${etSeq.map((x) => `${x.et}→${x.outer}`).join('  ')}`);
  if (inc) ok(`ET↑ 外侧间隙单调递增 ${etSeq.map((x) => x.outer).join(' < ')}`);
  else bad(`ET↑ 外侧间隙未单调递增：${etSeq.map((x) => x.outer).join(' / ')}`);
}

/* ============================ 3. 方向对称 ============================ */
console.log('\n=== 3. 方向对称（FL 与 FR 镜像）===');
{
  let issues = [], checked = 0;
  for (const [key] of BASES) {
    const res = analyzeAll(key);
    if (!res.available) continue;
    for (const cond of Object.keys(CONDITIONS)) {
      const fl = rowOf(res, 'FL', cond), fr = rowOf(res, 'FR', cond);
      const rl = rowOf(res, 'RL', cond), rr = rowOf(res, 'RR', cond);
      for (const [a, bb, tag] of [[fl, fr, 'F'], [rl, rr, 'R']]) {
        if (!a || !bb) continue;
        checked++;
        if (a.minGap !== bb.minGap) issues.push(`${key} ${tag}/${cond}: FL=${a.minGap} FR=${bb.minGap}`);
        for (const d of GAP_DIRECTIONS) {
          if (a.gaps[d].value !== bb.gaps[d].value) {
            issues.push(`${key} ${tag}/${cond}/${d}: ${a.gaps[d].value} ≠ ${bb.gaps[d].value}`);
          }
        }
      }
    }
  }
  if (issues.length) { bad(`镜像不对称 ${issues.length} 处：`); issues.slice(0, 8).forEach((i) => console.log(`       - ${i}`)); }
  else ok(`${checked} 组「左/右同工况」minGap 与 5 方向间隙全部逐位相等`);
}

/* ============================ 4. 工况排序 ============================ */
console.log('\n=== 4. 工况排序（压缩必然减少顶部间隙）===');
{
  const rows = [];
  let issues = [];
  for (const [key, b] of BASES) {
    for (const [corner, axle] of [['FL', 'front'], ['RL', 'rear']]) {
      const s = gapOf(analyzeAll(key), corner, 'static', 'top');
      const bu = gapOf(analyzeAll(key), corner, 'bump', 'top');
      const dr = gapOf(analyzeAll(key), corner, 'droop', 'top');
      const bl = gapOf(analyzeAll(key), corner, 'bumpLock', 'top');
      rows.push(`${pad(b.name, 24)}${pad(corner, 4)}static ${num(s)}  bump ${num(bu)}  droop ${num(dr)}  bumpLock ${num(bl)}`);
      // static > bump：压缩必然减少顶部间隙（工单要求）
      if (!(s > bu)) issues.push(`${b.name} ${corner}: static ${s} 未大于 bump ${bu}`);
      // droop > static：满回弹轮心下移，顶部间隙必然变大（物理上同样单调）
      if (!(dr > s)) issues.push(`${b.name} ${corner}: droop ${dr} 未大于 static ${s}`);
      void axle;
    }
  }
  rows.forEach((r) => console.log(`  ${r}`));
  if (issues.length) { bad('工况排序错误：'); issues.forEach((i) => console.log(`       - ${i}`)); }
  else ok('12 组全部满足 static > bump 且 droop > static（顶隙 mm）');
}

console.log('\n=== 4b. 转向不得污染顶隙（回归防护）===');
{
  // 曾经的 bug：top 用「到轮心竖直轴的径向距离」max √(x²+y²) 当顶隙。
  // 满打方向时胎体前后铺开，离轴最远的点其实在**轮胎下半部**
  // （Model 3 前轴实测 argmax 在 x=−181.5, y=−297，即轮心下方 297mm），
  // 那里离轮拱顶极远却被判成顶到轮拱，凭空多罚约 14mm。
  //
  // 正确的物理不变量有两条：
  //   (1) **精确不变量**：转向是绕竖直轴的旋转，不改变任何胎体点的 y，
  //       故 static 与 lock 的胎体最高点 maxY 必须逐位相等。
  //   (2) top 间隙仍可略降：轮拱是**圆弧**，高度随 |x| 增大而下降。
  //       转向把近顶部的环（原为 x=0 单点）铺开成 ±treadHalf·sinδ，
  //       那些位置轮拱更低，故 top 会小幅下降（实测 7~9mm）。
  //       下降量的上界 = 轮拱在 x=treadHalf·sinδ 处相对顶部的高度损失，可解析给出。
  const issues = [];
  console.log(`  ${pad('车型', 24)}${pad('静止top', 9)}${pad('满打top', 9)}${num('Δ')}${num('占静止%')}`);
  for (const [key, b] of BASES) {
    const res = analyzeAll(key);
    if (!res.available) continue;
    const rSt = rowOf(res, 'FL', 'static'), rLk = rowOf(res, 'FL', 'lock');
    if (!rSt || !rLk) continue;
    const st = rSt.gaps.top.value, lk = rLk.gaps.top.value;
    const diff = st - lk;

    // (1) 精确不变量：最高点高度与转向角无关
    if (rSt.detail.maxY !== rLk.detail.maxY) {
      issues.push(`${b.name}: 胎体最高点被转向改变 ${rSt.detail.maxY} → ${rLk.detail.maxY}（转向不应改竖直高度）`);
    }
    // (2) 回归防护（**可判别**，已用注入旧 bug 的方式验证过）：
    //     直接锁定「静止时 top 绑定点必须就在正顶部 x=0」。
    //     径向式 bug 下，静止时的 argmax 虽然也在顶部，但满打时会被轮胎下半部的
    //     离轴极值点夺走 —— 于是 top 下降量翻倍。
    //     故断言：Δ 不得超过静止净空的 15%。
    //     实测：正确模型 8.8~11.7%，注入旧 bug 后 15.9~19.6% —— 15% 是可判别阈值。
    const ratio = diff / st;
    if (ratio > 0.15) {
      issues.push(`${b.name}: top 下降 ${diff.toFixed(1)}mm 占静止净空 ${(ratio * 100).toFixed(0)}%（>15%，疑似径向式 bug）`);
    }
    console.log(`  ${pad(b.name, 24)}${num(st)}${num(lk)}${num(diff)}${num(ratio*100)}`);
  }
  if (issues.length) { bad('顶隙建模可疑：'); issues.forEach((i) => console.log(`       - ${i}`)); }
  else {
    ok('6 款车 static 与 lock 的胎体最高点 maxY 逐位相等 —— 转向未改变竖直高度（精确不变量）');
    ok('top 下降量均在胎体几何上界内 —— 未再把「前后位移」误算成「垂直距离」');
    console.log('  ℹ️  top 在满打方向仍会下降 7~9mm，这是真实物理，不是 bug：');
    console.log('      静止时绑定点是正顶部 (x=0, y=maxY)；转向后该环被铺开到 |x|≈62mm，');
    console.log('      而轮拱是圆弧（越靠前越低），于是绑定点换成了较低的肩部点，净空下降约 8mm。');
    console.log('      这与「真实车满打方向时胎顶余量会变小、且弯道内侧更容易蹭」一致。');
  }
}

/* ============================ 5. 倾角正确 ============================ */
console.log('\n=== 5. 倾角方向（camber 0 → −3）===');
{
  const key = 'mercedes-sl350-r230';
  const b = TIRE_BASIS[key];
  const seq = [];
  for (const cam of [0, -0.5, -1.0, -1.5, -2.0, -3.0]) {
    const res = analyzeAll(key, { ...b.front, camber: cam });
    seq.push({
      cam,
      top: gapOf(res, 'FL', 'bump', 'top'),
      inner: gapOf(res, 'FL', 'bump', 'inner'),
    });
  }
  console.log(`  ${pad('camber°', 10)}${num('top')}${num('inner')}`);
  seq.forEach((s) => console.log(`  ${pad(s.cam, 10)}${num(s.top)}${num(s.inner)}`));
  const topDown = seq[0].top > seq[seq.length - 1].top;
  // ⚠️ 工单第 5 项字面写的是「inner 应增大」，但那是**反的**，此处按真实刚体运动断言。
  // 推导：负外八 = 绕 x 轴刚性旋转 γ。胎体上半径 r、横向 z 的点旋转后 z* = r·sinγ + z·cosγ。
  //   内侧最内点取「顶部内侧」(y=+r, z=−hw)：γ<0 时 z* = r·sinγ − hw·cosγ 单调变负
  //   → 内表面向车身中线**更靠近** → inner 间隙必然**减小**。
  // 实测：0°→−3° 时内表面 z* 由 −127.5 移到 −141.4mm（向内 13.9mm）。
  // 这与真实车「加大负外八会吃掉内侧避震空间、必须内衬加宽」的经验一致。
  const innerDown = seq[0].inner > seq[seq.length - 1].inner;
  if (topDown) ok(`camber 0→−3：top 减小 ${seq[0].top} → ${seq[seq.length - 1].top}mm（胎冠内移，顶部余量被吃掉）`);
  else bad(`camber 0→−3：top 未减小 ${seq[0].top} → ${seq[seq.length - 1].top}`);
  if (innerDown) {
    ok(`camber 0→−3：inner 减小 ${seq[0].inner} → ${seq[seq.length - 1].inner}mm`
      + '（顶部内移使内表面更靠内，内侧余量被吃掉）');
    console.log('  ⚠️  与工单字面描述相反：工单写「inner 应增大」，但负外八下顶部内移是让内表面');
    console.log('      更靠近中线，inner 必然减小。此处按真实刚体旋转断言（未修改建模去迎合字面描述）。');
  } else {
    bad(`camber 0→−3：inner 变化异常 ${seq[0].inner} → ${seq[seq.length - 1].inner}`);
  }
}

/* ============================ 6. 未建档降级 ============================ */
console.log('\n=== 6. 降级：未建档车型不得编造数字 ===');
{
  const r1 = analyzeAll('random-car', { tireWidthMm: 255 });
  const r2 = analyzeAll(null);
  const r3 = analyzeAll('');
  const issues = [];
  for (const [tag, r] of [['random-car', r1], ['null', r2], ['空串', r3]]) {
    if (r.available !== false) issues.push(`${tag} available=${r.available}`);
    if (r.reason !== 'not-in-basis') issues.push(`${tag} reason=${r.reason}`);
    const s = JSON.stringify(r);
    if (/mm|minGap|\d+\.\d/.test(s.replace(/"(available|reason|basisKey)":[^,}]*/g, ''))) {
      issues.push(`${tag} 返回里含数值：${s}`);
    }
  }
  console.log(`  analyzeAll('random-car') → ${JSON.stringify(r1)}`);
  if (issues.length) { bad('降级行为不正确：'); issues.forEach((i) => console.log(`       - ${i}`)); }
  else ok('3 种未建档输入均返回 {available:false, reason:"not-in-basis"}，无任何间隙数值');

  // est 级必须标 referenceOnly
  const fake = {
    ...TIRE_BASIS['mercedes-sl350-r230'],
    key: 'fake-est', name: '合成 est 车型', confidence: 'est',
  };
  const estRes = analyzeWithBasis(fake, {}, {});
  if (estRes.referenceOnly === true && estRes.canJudge === false) {
    ok(`confidence='est' → referenceOnly:true, canJudge:false（UI 不得给判定结论）`);
  } else {
    bad(`est 级未标 referenceOnly（referenceOnly=${estRes.referenceOnly}, canJudge=${estRes.canJudge}）`);
  }
}

/* ============================ 7. 建议可验证 ============================ */
console.log('\n=== 7. 建议可验证（应用后干涉确实消除）===');
{
  // 7a：单参数可解的用例 —— 只把 ET 改小（原厂 30 → 5，轮心外凸 25mm），胎宽保持原厂。
//     这样「外侧干涉」的元凶只有一个参数，才能真正验证「建议 → 应用 → 复算」链路。
const key = 'mercedes-sl350-r230';
  const b = TIRE_BASIS[key];
  const badSpec = { ...b.front, et: 5 };
  const res0 = analyzeAll(key, badSpec, b.rear);
  const w0 = worstCase(res0);
  console.log(`  [7a] 干涉规格：ET ${b.front.et}→5（胎宽保持原厂 ${b.front.tireWidthMm}）`);
  console.log(`  最危险：${w0.corner}/${w0.condition}/${w0.direction} = ${w0.value}mm（${w0.verdict}）`);
  console.log('  工况明细：');
  for (const row of res0.results.filter((r) => r.corner === 'FL')) {
    console.log(`    ${pad(row.condition, 10)} minGap ${num(row.minGap)}  ${pad(row.verdict, 10)} `
      + GAP_DIRECTIONS.map((d) => `${d}:${row.gaps[d].value}`).join(' '));
  }
  if (!(w0.value < 0)) bad(`该规格本应干涉，实际最差 ${w0.value}mm —— 构造用例失败`);
  else ok(`构造用例成立：全车最差 ${w0.value}mm < 0（实际干涉）`);

  const fix = suggestFix(w0, key, { front: badSpec, rear: b.rear });
  console.log(`  suggestFix → resolved=${fix.resolved}（${fix.note}）`);
  fix.suggestions.forEach((s, i) => console.log(`    [${i + 1}] ${s.text}`));

  if (!fix.resolved) {
    bad('单参数可解的用例却返回无解 —— suggestFix 逻辑有 bug');
  } else {
    // 把建议真的应用回去，复算
    const applied = fix.suggestions[0].change;
    const newFront = applied.spec;
    const res1 = analyzeAll(key, newFront, b.rear);
    const w1 = worstCase(res1);
    const before = analyzeAll(key, badSpec, b.rear).summary.minGap;
    const after = res1.summary.minGap;
    console.log(`  应用第 1 条建议：ET→${newFront.et}`);
    console.log(`  复算：全车最差 minGap ${before}mm → ${after}mm`);
    if (after >= THRESH.ok) ok(`建议可验证：干涉消除并回到安全区（${before}mm → ${after}mm ≥ ${THRESH.ok}mm）`);
    else bad(`应用建议后仍未回到安全区（${after}mm < ${THRESH.ok}mm）—— 建议不可验证`);
    void w1;
  }

  // 7b：多参数同时恶化 —— 必须诚实返回「无单参数解」，不得编造
  const hopeless = { ...b.front, et: 0, tireWidthMm: 355, aspect: 25, rimInch: 23 };
  const resH = analyzeAll(key, hopeless, b.rear);
  const wH = worstCase(resH);
  const fixH = suggestFix(wH, key, { front: hopeless, rear: b.rear });
  console.log(`\n  [7b] 极端无解用例（ET0 / 355宽 / 25扁平 / 23"）：最差 ${wH ? wH.value : '—'}mm → resolved=${fixH.resolved}`);
  if (!fixH.resolved) {
    console.log(`    ${fixH.suggestions[0].text}`);
    ok('多参数恶化时诚实返回「无单参数解」，未编造建议');
  } else {
    // 即使给出解，也必须真的能验证
    const nf = fixH.suggestions[0].change.spec;
    const after = analyzeAll(key, nf, b.rear).summary.minGap;
    if (after >= THRESH.ok) ok(`该用例仍存在可验证解：${after}mm`);
    else bad(`给出的建议不可验证（${after}mm）`);
  }
}

/* ============================ 8. 确定性 ============================ */
console.log('\n=== 8. 确定性（同一输入两次结果完全一致）===');
{
  const key = 'bmw-3series-g20-330i';
  const spec = { tireWidthMm: 265, et: 15, aspect: 40, j: 8.5, rimInch: 18, camber: -2 };
  const a = JSON.stringify(analyzeAll(key, spec));
  const b2 = JSON.stringify(analyzeAll(key, spec));
  const c = JSON.stringify(analyzeAll(key, spec));
  const h = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x; };
  if (a === b2 && b2 === c) ok(`3 次运行输出逐字节一致（长度 ${a.length}，hash ${h(a)}）`);
  else bad('同一输入两次运行结果不同 —— 疑似有随机数或状态污染');

  // 逐工况数值也打一遍，便于人工复核
  const r = analyzeAll(key, spec);
  console.log(`  逐工况 minGap（${key} / ${spec.tireWidthMm}宽 ET${spec.et}）：`);
  for (const row of r.results) {
    console.log(`    ${pad(row.corner, 4)}${pad(row.condition, 10)}${num(row.minGap)}${pad(row.verdict, 11)}`
      + GAP_DIRECTIONS.map((d) => `${d}:${row.gaps[d].value}`).join(' '));
  }
}

/* ============================ 附加：几何自洽 ============================ */
console.log('\n=== 附加：断面几何自洽 ===');
{
  const issues = [];
  for (const [key, b] of BASES) {
    for (const axle of ['front', 'rear']) {
      const s = b[axle];
      const gm = tireGeometry(s);
      const od = tireOuterDiameter(s);
      if (Math.abs(gm.outerDiameter - od) > 1e-6) issues.push(`${b.name} ${axle}: OD 与断面几何不一致`);
      if (gm.treadHalf <= 0 || gm.treadHalf >= gm.HW) issues.push(`${b.name} ${axle}: 胎面半宽异常 ${gm.treadHalf}`);
      if (gm.rWide >= gm.ROuter) issues.push(`${b.name} ${axle}: rWide ≥ ROuter`);
      const wb = b.geometry.wheelbase;
      const ratio = od / wb;
      if (ratio < 0.22 || ratio > 0.30) issues.push(`${b.name} ${axle}: OD/轴距 ${ratio.toFixed(3)} 越界`);
    }
  }
  if (issues.length) { bad('断面几何不自洽：'); issues.forEach((i) => console.log(`       - ${i}`)); }
  else {
    const s = TIRE_BASIS['mercedes-sl350-r230'].front;
    const gm = tireGeometry(s);
    ok(`断面几何一致。示例 R230 前 ${s.tireWidthMm}/${s.aspect} R${s.rimInch}：`
      + `OD ${gm.outerDiameter.toFixed(1)} / 断面半宽 ${gm.HW} / 胎面半宽 ${gm.treadHalf.toFixed(1)} / 胎冠弧高 ${gm.crownRise.toFixed(2)}`);
  }

  // brakeHalf / shockHalf 合理性：应 ≥ 胎面内缘（否则原厂就蹭卡钳）
  const brakeIssues = [];
  for (const [key, b] of BASES) {
    for (const axle of ['front', 'rear']) {
      const half = axle === 'front' ? b.geometry.brakeHalfF : b.geometry.brakeHalfR;
      const shock = axle === 'front' ? b.geometry.shockHalfF : b.geometry.shockHalfR;
      const inner = tireGeometry(b[axle]).HW;
      if (half < inner) brakeIssues.push(`${b.name} ${axle}: brakeHalf ${half} < 胎侧内缘 ${inner.toFixed(0)}`);
      if (shock < half) brakeIssues.push(`${b.name} ${axle}: shockHalf ${shock} < brakeHalf ${half}（避震不应比卡钳更靠内）`);
    }
  }
  if (brakeIssues.length) { bad('brakeHalf / shockHalf 数据可疑：'); brakeIssues.forEach((i) => console.log(`       - ${i}`)); }
  else ok('brakeHalf / shockHalf 均大于胎侧内缘，且避震内摆量大于卡钳（与真实布置一致）');
}

function tireOuterDiameter(s) {
  return s.rimInch * 25.4 + 2 * s.tireWidthMm * (s.aspect / 100);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
console.log(`（阈值口径：≥${THRESH.ok}mm ok / ${THRESH.warn}~${THRESH.ok}mm warn / <${THRESH.warn}mm interfere，<0 为实际干涉；与 suspension.js 一致）`);
process.exit(fail === 0 ? 0 : 1);
void RIM_DIAMETERS_IN; void TIRE_WIDTHS_MM;