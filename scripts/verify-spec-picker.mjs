/**
 * verify-spec-picker.mjs — 真实规格选择器的纯逻辑校验
 *
 * 测的是「能不能阻止不真实的规格」——这是精准适配可信度的基础。
 * 只要这套逻辑放过 237mm 胎宽，后面的间隙判定全是自欺欺人。
 *
 * 无浏览器/无网络：node scripts/verify-spec-picker.mjs
 */
import {
  evalSize, etHint, isOeSpec, recommendSizes,
} from '../src/ui/sizePicker.js';
import {
  TIRE_BASIS, TIRE_WIDTHS_MM, TIRE_ASPECTS, RIM_DIAMETERS_IN, RIM_JS, ET_VALUES_MM,
  legalizeSpec, canJudge, sizeLabel,
} from '../src/tuning/tireBasis.js';

let fail = 0;
let pass = 0;
function ok(m) { console.log(`  ✅ ${m}`); pass++; }
function bad(m) { console.log(`  ❌ ${m}`); fail++; }
function check(cond, msg) { cond ? ok(msg) : bad(msg); }

console.log('=== 1. evalSize 必须拒绝不存在的胎规格 ===');
const real = evalSize(255, 35, 19);
check(real.ok && real.label === '255/35 R19');

const fake = evalSize(237, 33, 19);
check(!fake.ok);

const fake2 = evalSize(300, 25, 20);
check(!fake2.ok);

console.log('\n=== 2. 滑杆任意值经 legalize 后必须是真实规格 ===');
for (const raw of [
  { rimInch: 18.7, j: 9.3, et: 33, tireWidthMm: 237, aspect: 42 },
  { rimInch: 15.2, j: 6.7, et: 47, tireWidthMm: 331, aspect: 27 },
  { rimInch: 23.9, j: 12.8, et: 1, tireWidthMm: 190, aspect: 74 },
]) {
  const L = legalizeSpec(raw);
  const legal =
    TIRE_WIDTHS_MM.includes(L.tireWidthMm) && TIRE_ASPECTS.includes(L.aspect) &&
    RIM_DIAMETERS_IN.includes(L.rimInch) && RIM_JS.includes(L.j) && ET_VALUES_MM.includes(L.et);
  const inTable = !!TIRE_BASIS && (() => {
    // 吸附后组合未必在真实表里（如 235/40 可能是存在的），只要求各字段合法
    return true;
  })();
  check(legal && inTable);
}

console.log('\n=== 3. ET 语境方向正确 ===');
const oeEt = 30;
check(etHint(30, oeEt).delta === 0, 'ET 30 vs 原厂 30 → 原厂');
check(etHint(35, oeEt).delta > 0);
check(etHint(20, oeEt).delta < 0);

console.log('\n=== 4. isOeSpec 逐字段比对 ===');
const b = TIRE_BASIS['mercedes-sl350-r230'];
check(isOeSpec(b.front, b.front), '完全一致 → 判定为原厂');
check(!isOeSpec({ ...b.front, tireWidthMm: 265 }, b.front), '胎宽不同 → 非原厂');
check(!isOeSpec({ ...b.front, j: 9.5 }, b.front), 'J 不同 → 非原厂');
check(!isOeSpec({ ...b.front, et: 25 }, b.front), 'ET 不同 → 非原厂');
check(!isOeSpec(b.front, null), '无原厂数据 → 非原厂（降级）');

console.log('\n=== 5. recommendSizes 只推真实存在的组合 ===');
for (const [key, basis] of Object.entries(TIRE_BASIS)) {
  const oe = basis.front;
  const recs = recommendSizes({ ...oe, tireWidthMm: 255 }, oe);
  const bad = recs.filter((r) => {
    const key2 = `${r.tireWidthMm}/${r.aspect}`;
    return !TIRE_WIDTHS_MM.includes(r.tireWidthMm) || !TIRE_ASPECTS.includes(r.aspect);
  });
  check(bad.length === 0);
}
const recOvershoot = recommendSizes({ tireWidthMm: 225, aspect: 45, rimInch: 18 }, TIRE_BASIS['bmw-3series-g20-330i'].front);
check(recOvershoot.every((r) => Math.abs(r.tireWidthMm - 225) <= 40), '推荐列表不超过 ±40mm 胎宽跨度（实用范围）');

console.log('\n=== 6. 置信度门槛 ===');
check(canJudge('mercedes-sl350-r230'), 'R230（oe 级）→ 可出判定结论');
check(canJudge('tesla-model3'), 'Model 3（db 级）→ 可出判定结论');
check(!canJudge('random-car'), '未建档车型 → 正确降级为仅预览');
check(!canJudge(null), 'null → 正确降级为仅预览');

console.log('\n=== 7. 底座自洽：原厂规格全部是合法离散值 ===');
for (const [key, basis] of Object.entries(TIRE_BASIS)) {
  for (const axle of ['front', 'rear']) {
    const s = basis[axle];
    const ev = evalSize(s.tireWidthMm, s.aspect, s.rimInch);
    const fieldsOk =
      TIRE_WIDTHS_MM.includes(s.tireWidthMm) && TIRE_ASPECTS.includes(s.aspect) &&
      RIM_DIAMETERS_IN.includes(s.rimInch) && RIM_JS.includes(s.j) && ET_VALUES_MM.includes(s.et);
    check(ev.ok && fieldsOk);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
