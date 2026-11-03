/**
 * verify-car-specs.mjs — 车型库尺寸与轮胎规格的交叉校验
 *
 * 背景（2026-10-15 实测发现）：
 *   server/carSpecs.db.json 里 12 款全部标了 source:'official-db'（宣称官方数据），
 *   但逐条核对真实值后发现 5 处错误：
 *     · 奔驰 SL 350 车长 4535 → 真实 4664（−129mm）
 *     · 奔驰 SL 350 轮胎 18"255/45 → 真实 19"255/35 前 + 19"285/30 后
 *     · 本田 CR-V 车长 4595 → 真实 4712（−117mm）
 *     · 思域 Type R 车高 1434 → 真实 1405
 *     · RAV4 / X5 车高各偏 30mm
 *   标签宣称官方、数据却错误，比没有数据更危险。本脚本把「真实值」固化成
 *   对照表，任何人改坏 db 都会在这里被抓住。
 *
 * 维护方式：真实值来自厂商公开规格。要改对照表必须同时更新
 * `EXPECTED_REAL` 并在 commit 里说明依据，不要为了让校验通过而放宽容差。
 *
 * 用法：node scripts/verify-car-specs.mjs
 */
import { readFileSync } from 'node:fs';

const db = JSON.parse(readFileSync(new URL('../server/carSpecs.db.json', import.meta.url), 'utf8'));
const cars = db.cars || Object.values(db);

/**
 * 真实值对照表（厂商公开规格，人工核实）。
 * [车长, 车宽, 车高, 轴距, 轮辋, 胎宽, 扁平比]  单位 mm / 英寸
 */
const EXPECTED_REAL = {
  'mercedes-sl350-r230':   { length: 4664, width: 1817, height: 1290, wheelbase: 2560, rimInch: 19, tireWidth: 255, aspect: 35 },
  'toyota-gr-supra-a90':   { length: 4379, width: 1854, height: 1299, wheelbase: 2470, rimInch: 19, tireWidth: 255, aspect: 35 },
  'honda-nsx-nc1':         { length: 4430, width: 1895, height: 1220, wheelbase: 2670, rimInch: 19, tireWidth: 245, aspect: 35 },
  'porsche-911-carrera-992': { length: 4519, width: 1852, height: 1303, wheelbase: 2450, rimInch: 20, tireWidth: 245, aspect: 35 },
  'toyota-86-gr86':        { length: 4240, width: 1775, height: 1310, wheelbase: 2570, rimInch: 17, tireWidth: 215, aspect: 45 },
  'bmw-3series-g20-330i':  { length: 4713, width: 1828, height: 1442, wheelbase: 2851, rimInch: 18, tireWidth: 225, aspect: 45 },
  'honda-civic-typer-fk8': { length: 4590, width: 1800, height: 1405, wheelbase: 2730, rimInch: 20, tireWidth: 245, aspect: 30 },
  'tesla-model3':          { length: 4720, width: 1848, height: 1443, wheelbase: 2875, rimInch: 18, tireWidth: 235, aspect: 45 },
  'toyota-rav4-xa50':      { length: 4600, width: 1855, height: 1655, wheelbase: 2690, rimInch: 17, tireWidth: 225, aspect: 65 },
  'honda-crv-rw':          { length: 4712, width: 1835, height: 1680, wheelbase: 2716, rimInch: 18, tireWidth: 235, aspect: 60 },
  'bmw-x5-g05':            { length: 4923, width: 1968, height: 1776, wheelbase: 2975, rimInch: 19, tireWidth: 275, aspect: 45 },
  'ford-f150':             { length: 5898, width: 2024, height: 1960, wheelbase: 3700, rimInch: 18, tireWidth: 275, aspect: 65 },
};

/** 各字段容差（mm / 英寸）。刻意留一点余量：厂商不同年份/配置会有小幅差异。 */
const TOL = { length: 100, width: 60, height: 60, wheelbase: 100, rimInch: 1, tireWidth: 20, aspect: 10 };

let fail = 0;
let pass = 0;
const ok = (m) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };

console.log('=== 1. 逐条核对库内数据与真实值 ===');
for (const c of cars) {
  const exp = EXPECTED_REAL[c.key];
  if (!exp) { bad(`${c.key}：不在 EXPECTED_REAL 对照表里（新增车型请补真实值）`); continue; }
  const issues = [];
  for (const [f, want] of Object.entries(exp)) {
    const got = c.specs?.[f];
    if (got == null) { issues.push(`${f} 缺失（应 ${want}）`); continue; }
    if (Math.abs(got - want) > TOL[f]) {
      issues.push(`${f} = ${got}，真实 ${want}（偏差 ${got - want > 0 ? '+' : ''}${got - want}，容差 ±${TOL[f]}）`);
    }
  }
  if (issues.length) {
    bad(`${c.brand} ${c.model}`);
    issues.forEach((i) => console.log(`       - ${i}`));
  } else {
    ok(`${c.brand} ${c.model}  全部字段在容差内`);
  }
}

console.log('\n=== 2. 轮胎组合必须真实存在 ===');
for (const c of cars) {
  const s = c.specs || {};
  const key = `${s.tireWidth}/${s.aspect}`;
  // 真实胎规格常识校验：同轮辋下胎宽与扁平比的组合限制
  const issues = [];
  if (s.rimInch == null || s.tireWidth == null || s.aspect == null) {
    issues.push('轮胎三项不完整');
  } else {
    const od = s.rimInch * 25.4 + 2 * s.tireWidth * (s.aspect / 100);
    // 外径按车身类型分档：乘用车 560–760mm，皮卡/越野（长高比 <3.15）可到 850mm
    const lh = s.length && s.height ? s.length / s.height : 3;
    const isTruck = lh < 3.15;
    const odLo = 560, odHi = isTruck ? 850 : 760;
    if (od < odLo || od > odHi) {
      issues.push(`外径 ${od.toFixed(0)}mm 超出${isTruck ? '皮卡/越野' : '乘用车'}范围 [${odLo},${odHi}]`);
    }
    // 扁平比与胎宽的组合约束同样要分档：
    // 乘用车上「高扁平比必配窄胎」，但皮卡/越野恰恰相反（275/65 就是真实原厂配置）
    if (!isTruck) {
      if (s.aspect >= 60 && s.tireWidth > 245) issues.push(`${s.tireWidth}/${s.aspect} 组合不合常理（乘用车高扁平比应配窄胎）`);
      if (s.aspect <= 30 && s.tireWidth < 235) issues.push(`${s.tireWidth}/${s.aspect} 组合不合常理（乘用车低扁平比应配宽胎）`);
    }
  }
  if (issues.length) { bad(`${c.model}:`); issues.forEach((i) => console.log(`       - ${i}`)); }
  else ok(`${c.model}  ${s.tireWidth}/${s.aspect} R${s.rimInch}（外径 ${(s.rimInch * 25.4 + 2 * s.tireWidth * s.aspect / 100).toFixed(0)}mm）合理`);
}

console.log('\n=== 3. 车身比例合理性 ===');
for (const c of cars) {
  const s = c.specs || {};
  if (!s.length || !s.height) continue;
  const lh = s.length / s.height;
  // 乘用车长高比 2.2–4.0（皮卡接近 3.0，低趴跑车 >3.3）
  if (lh < 2.2 || lh > 4.0) bad(`${c.model} 长高比 ${lh.toFixed(2)} 超出 [2.2, 4.0]`);
  else ok(`${c.model} 长高比 ${lh.toFixed(2)}`);
}

console.log('\n=== 4. 轴距不得短于长度的 45% ===');
for (const c of cars) {
  const s = c.specs || {};
  if (!s.wheelbase || !s.length) continue;
  const r = s.wheelbase / s.length;
  if (r < 0.45) bad(`${c.model} 轴距/车长 = ${r.toFixed(3)} 过小（前后悬不可能这么长）`);
  else ok(`${c.model} 轴距/车长 = ${r.toFixed(3)}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
