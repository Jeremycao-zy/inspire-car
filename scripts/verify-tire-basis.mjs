/**
 * _qa-tire-basis.mjs — 轮胎数字底座离线校验（零成本、不开浏览器）
 *
 * 校验项：
 *   1. 每条原厂规格必须落在合法离散序列内（胎宽/扁平比/轮辋/J/ET）
 *   2. 原厂规格必须存在于「真实胎宽/扁平比」组合表里
 *   3. 外径合理性：与车高/车长比例不荒谬（外径 ≤ 车长 × 0.16）
 *   4. 几何自洽：轮拱半径 > 轮胎外半径（否则原厂就蹭了）
 *   5. 序列本身无重复、有序
 *   6. legalizeSpec 能把滑杆任意值吸附到合法值
 *
 * 用法：node scripts/_qa-tire-basis.mjs
 */
import {
  TIRE_BASIS, TIRE_WIDTHS_MM, TIRE_ASPECTS, RIM_DIAMETERS_IN, RIM_JS, ET_VALUES_MM,
  TIRE_SIZE_SERIES, isRealTireSize, legalizeSpec, sizeLabel, canJudge,
} from '../src/tuning/tireBasis.js';

let fail = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };

function tireOdMm(s) { return s.rimInch * 25.4 + 2 * s.tireWidthMm * (s.aspect / 100); }

console.log('=== 1. 序列有序无重复 ===');
for (const [name, arr] of [
  ['TIRE_WIDTHS_MM', TIRE_WIDTHS_MM], ['TIRE_ASPECTS', TIRE_ASPECTS],
  ['RIM_DIAMETERS_IN', RIM_DIAMETERS_IN], ['RIM_JS', RIM_JS], ['ET_VALUES_MM', ET_VALUES_MM],
]) {
  const sorted = [...arr].sort((a, b) => a - b);
  const dup = arr.length !== new Set(arr).size;
  if (dup) bad(`${name} 有重复值`);
  else if (JSON.stringify(arr) !== JSON.stringify(sorted)) bad(`${name} 未按升序排列`);
  else ok(`${name}  ${arr.length} 项，升序无重复`);
}

console.log('\n=== 2. 每款车型的原厂规格合法性 ===');
for (const [key, b] of Object.entries(TIRE_BASIS)) {
  const issues = [];
  for (const axle of ['front', 'rear']) {
    const s = b[axle];
    if (!TIRE_WIDTHS_MM.includes(s.tireWidthMm)) issues.push(`${axle} 胎宽 ${s.tireWidthMm} 不在序列`);
    if (!TIRE_ASPECTS.includes(s.aspect)) issues.push(`${axle} 扁平比 ${s.aspect} 不在序列`);
    if (!RIM_DIAMETERS_IN.includes(s.rimInch)) issues.push(`${axle} 轮辋 ${s.rimInch}" 不在序列`);
    if (!RIM_JS.includes(s.j)) issues.push(`${axle} J ${s.j} 不在序列`);
    if (!ET_VALUES_MM.includes(s.et)) issues.push(`${axle} ET ${s.et} 不在序列`);
    if (!isRealTireSize(s.tireWidthMm, s.aspect)) {
      issues.push(`${axle} ${sizeLabel(s)} 不在真实组合表（可能是编造的规格）`);
    }
  }
  if (issues.length) { bad(`${b.name}:`); issues.forEach((i) => console.log(`       - ${i}`)); }
  else ok(`${b.name}  前 ${sizeLabel(b.front)} / 后 ${sizeLabel(b.rear)}  confidence=${b.confidence}`);
}

console.log('\n=== 3. 几何自洽：原厂状态不得蹭胎（用 wheelCenterGain 算轮心位移）===');
// 建模要点：轮拱间隙的驱动量是「轮心相对车身上移量」= suspTravel × wheelCenterGain，
// 而不是 suspTravel 本身。用后者会把原厂算成 −60mm 蹭胎（本项目踩过的坑）。
for (const [key, b] of Object.entries(TIRE_BASIS)) {
  const g = b.geometry;
  const issues = [];
  const gaps = [];
  for (const axle of ['front', 'rear']) {
    const F = axle === 'front';
    const od = tireOdMm(b[axle]);
    const archR = F ? g.archRadiusF : g.archRadiusR;
    const travel = F ? g.suspTravelF : g.suspTravelR;
    const gain = F ? g.wheelCenterGainF : g.wheelCenterGainR;
    if (!(gain > 0 && gain < 1)) issues.push(`${axle} wheelCenterGain=${gain} 非法（应在 0~1）`);
    const rise = travel * gain;
    const staticGap = archR - od / 2;           // 静态：轮胎上缘到轮拱顶
    const fullGap = staticGap - rise;            // 满压缩：静态顶隙 − 轮心上移
    gaps.push(`${axle} 静态 ${staticGap.toFixed(0)} / 满压缩 ${fullGap.toFixed(0)}mm`);
    if (!(od / 2 < archR)) issues.push(`${axle} 轮胎外半径 ${(od / 2).toFixed(0)}mm ≥ 轮拱半径 ${archR}mm（静态即蹭）`);
    if (fullGap <= 0) issues.push(`${axle} 满压缩顶隙 ${fullGap.toFixed(0)}mm ≤ 0（原厂就蹭，数据不自洽）`);
    if (fullGap > 120) issues.push(`${axle} 满压缩顶隙 ${fullGap.toFixed(0)}mm > 120mm（轮拱数据疑似过大）`);
  }
  if (issues.length) { bad(`${b.name}:`); issues.forEach((i) => console.log(`       - ${i}`)); }
  else ok(`${b.name}  ${gaps.join(' | ')}`);
}

console.log('\n=== 4. 尺寸比例合理性 ===');
// 真实比例：胎外径 ≈ 轴距 × 0.25~0.28（运动车更低）。0.16 是错值（把外径当车高比了）。
for (const [key, b] of Object.entries(TIRE_BASIS)) {
  const od = tireOdMm(b.front) / 1000;
  const wb = b.geometry.wheelbase / 1000;
  const ratio = od / wb;
  if (ratio < 0.22 || ratio > 0.30) bad(`${b.name} 外径/轴距 = ${ratio.toFixed(3)} 超出合理区间 [0.22, 0.30]`);
  else ok(`${b.name} 外径/轴距 = ${ratio.toFixed(3)} 合理`);
}

console.log('\n=== 5. legalizeSpec 吸附行为 ===');
const probe = legalizeSpec({ rimInch: 18.7, j: 9.3, et: 33, tireWidthMm: 237, aspect: 42 });
const issues5 = [];
if (!TIRE_WIDTHS_MM.includes(probe.tireWidthMm)) issues5.push(`237 → ${probe.tireWidthMm} 非法`);
if (!RIM_DIAMETERS_IN.includes(probe.rimInch)) issues5.push(`18.7" → ${probe.rimInch}" 非法`);
if (!ET_VALUES_MM.includes(probe.et)) issues5.push(`33 → ${probe.et} 非法`);
if (!RIM_JS.includes(probe.j)) issues5.push(`9.3J → ${probe.j}J 非法`);
if (!TIRE_ASPECTS.includes(probe.aspect)) issues5.push(`42% → ${probe.aspect}% 非法`);
if (issues5.length) { bad('吸附后仍有非法值：'); issues5.forEach((i) => console.log(`       - ${i}`)); }
else ok(`237mm→${probe.tireWidthMm}mm, 18.7"→${probe.rimInch}", 33→${probe.et}mm, 42%→${probe.aspect}% 全部吸附到合法值`);

console.log('\n=== 6. 判定门槛 ===');
for (const key of Object.keys(TIRE_BASIS)) {
  const b = TIRE_BASIS[key];
  const can = canJudge(key);
  if (b.confidence === 'est' && can) bad(`${b.name} est 级却允许判定`);
  else ok(`${b.name} confidence=${b.confidence} → ${can ? '可出判定结论' : '仅预览'}`);
}
const unknown = canJudge('some-random-car');
if (unknown) bad('未建档车型竟被允许判定');
else ok('未建档车型正确降级为「仅预览」');

console.log('\n=== 7. 真实组合表覆盖度 ===');
const missing = [];
for (const b of Object.values(TIRE_BASIS)) {
  for (const axle of ['front', 'rear']) {
    const s = b[axle];
    if (!TIRE_SIZE_SERIES[`${s.tireWidthMm}/${s.aspect}`]) missing.push(`${b.name} ${axle} ${sizeLabel(s)}`);
  }
}
if (missing.length) { bad('组合表缺项：'); missing.forEach((m) => console.log(`       - ${m}`)); }
else ok(`组合表覆盖全部 ${Object.keys(TIRE_BASIS).length * 2} 条原厂规格`);

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
