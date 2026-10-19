/**
 * _qa-suspension.mjs — src/tuning/suspension.js 纯函数单测
 *
 * 不依赖浏览器、不消耗真实额度，可直接运行：
 *   node scripts/_qa-suspension.mjs
 *
 * 覆盖：tireOuterDiameterMm / suspensionReadout / fenderStatus（含边界
 *       Δ=0、Δ=75、gap<0、gap=5、gap=10、离地<100）。
 */

import {
  tireOuterDiameterMm,
  suspensionReadout,
  fenderStatus,
  groundClearanceStatus,
  deltaStatus,
  MIN_GROUND_CLEARANCE_MM,
  MAX_TOTAL_DELTA_MM,
  FENDER_SAFE_MM,
  FENDER_MIN_MM,
} from '../src/tuning/suspension.js';

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    fails.push(name);
    console.log(`  ❌ ${name}${extra ? '  →  ' + extra : ''}`);
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

console.log('\n═══════ suspension.js 纯函数单测 ═══════\n');

/* ---- tireOuterDiameterMm ---- */
console.log('— tireOuterDiameterMm —');
// 19" 255/35：482.6 + 2×255×0.35 = 482.6 + 178.5 = 661.1
ok('19" 255/35 → 661.1mm', approx(tireOuterDiameterMm(19, 255, 35), 661.1, 1e-6), `${tireOuterDiameterMm(19, 255, 35)}`);
ok('18" 225/45 → 659.7mm', approx(tireOuterDiameterMm(18, 225, 45), 659.7, 1e-6), `${tireOuterDiameterMm(18, 225, 45)}`);
ok('0 输入 → 0', tireOuterDiameterMm(0, 0, 0) === 0);

/* ---- suspensionReadout ---- */
console.log('\n— suspensionReadout（baseGC=125, baseFG=45）—');
{
  const r0 = suspensionReadout({ baseGroundClearanceMm: 125, baseFenderGapMm: 45, deltaMm: 0 });
  ok('Δ=0: groundClearance=125', r0.groundClearance === 125);
  ok('Δ=0: fenderGap=45', r0.fenderGap === 45);
  ok('Δ=0: wheelExposureRatio≈0.1176', approx(r0.wheelExposureRatio, 10 / 85, 1e-9), `${r0.wheelExposureRatio}`);
}
{
  const r75 = suspensionReadout({ baseGroundClearanceMm: 125, baseFenderGapMm: 45, deltaMm: 75 });
  ok('Δ=75: groundClearance=50', r75.groundClearance === 50);
  ok('Δ=75: fenderGap=−30', r75.fenderGap === -30);
  ok('Δ=75: wheelExposureRatio=1', approx(r75.wheelExposureRatio, 1, 1e-9), `${r75.wheelExposureRatio}`);
}
{
  // 边界：Δ 为区间端点 −10（升高）
  const rMin = suspensionReadout({ baseGroundClearanceMm: 125, baseFenderGapMm: 45, deltaMm: -10 });
  ok('Δ=−10: groundClearance=135', rMin.groundClearance === 135);
  ok('Δ=−10: wheelExposureRatio=0', rMin.wheelExposureRatio === 0);
}

/* ---- fenderStatus ---- */
console.log('\n— fenderStatus（≥10 good / ≥5 warn / <5 danger）—');
ok('gap=10 → good', fenderStatus(10) === 'good');
ok('gap=45 → good', fenderStatus(45) === 'good');
ok('gap=5  → warn', fenderStatus(5) === 'warn');
ok('gap=7  → warn', fenderStatus(7) === 'warn');
ok('gap=4  → danger', fenderStatus(4) === 'danger');
ok('gap=0  → danger', fenderStatus(0) === 'danger');
ok('gap=−1 → danger（<0 必蹭）', fenderStatus(-1) === 'danger');

/* ---- groundClearanceStatus ---- */
console.log('\n— groundClearanceStatus（<100 danger / 100–120 warn / ≥120 good）—');
ok('gc=125 → good', groundClearanceStatus(125) === 'good');
ok('gc=120 → good', groundClearanceStatus(120) === 'good');
ok('gc=110 → warn', groundClearanceStatus(110) === 'warn');
ok('gc=100 → warn', groundClearanceStatus(100) === 'warn');
ok('gc=99  → danger（<100）', groundClearanceStatus(99) === 'danger');
ok('gc=0   → danger', groundClearanceStatus(0) === 'danger');

/* ---- deltaStatus ---- */
console.log('\n— deltaStatus（|Δ| ≤30 good / 30–50 warn / >50 danger）—');
ok('Δ=0   → good', deltaStatus(0) === 'good');
ok('Δ=30  → good', deltaStatus(30) === 'good');
ok('Δ=−30 → good', deltaStatus(-30) === 'good');
ok('Δ=40  → warn', deltaStatus(40) === 'warn');
ok('Δ=−45 → warn', deltaStatus(-45) === 'warn');
ok('Δ=50  → warn', deltaStatus(50) === 'warn');
ok('Δ=60  → danger', deltaStatus(60) === 'danger');
ok('Δ=−75 → danger', deltaStatus(-75) === 'danger');

/* ---- 常量自检 ---- */
console.log('\n— 红线常量 —');
ok('MIN_GROUND_CLEARANCE_MM=100', MIN_GROUND_CLEARANCE_MM === 100);
ok('MAX_TOTAL_DELTA_MM=50', MAX_TOTAL_DELTA_MM === 50);
ok('FENDER_SAFE_MM=10', FENDER_SAFE_MM === 10);
ok('FENDER_MIN_MM=5', FENDER_MIN_MM === 5);

console.log(`\n═══════ 结果：${pass} 通过 / ${fail} 失败 ═══════`);
if (fail) {
  console.log('失败用例：', fails.join('、'));
  process.exit(1);
}
console.log('✅ 全部通过');
process.exit(0);
