/**
 * verify-et-3d.mjs — ET 必须真实驱动 3D 轮位（回归护栏）
 *
 * 背景（2026-10-15 用户指出）：「数据调节反应不出真实效果」。
 * 核实后确认属实 —— `chassis.js` 的 `cornerSpec()` 曾把轮位写死 `z = ±halfTrack`，
 * **完全不随 ET 变化**：面板里把 ET 从 30 拖到 10，3D 里的轮子纹丝不动。
 * 修复由 `src/tuning/wheelPlacement.js` 提供（hubOffsetMm = oeEt − et）。
 *
 * 本脚本锁定四条性质，防止将来被改回"轮位写死"的状态：
 *   1. FL.z 随 ET 减小而单调增大
 *   2. 原厂 ET 时零位移（与改造前逐字节一致，向后兼容）
 *   3. 外凸/内缩量与 ET 差值精确相等（1mm 对 1mm，不允许有缩放误差）
 *   4. 前后轴独立、左右镜像
 *
 * 用法：node scripts/verify-et-3d.mjs
 */
import { Chassis } from '../src/tuning/chassis.js';

const metrics = { bodyHalfWidth: 0.9085, lengthNorm: 4.664 };   // R230
const real = { wheelbase: 2.560, halfTrack_F: 0.7675, halfTrack_R: 0.7635, rideHeight: 0.13 };
const OE_ET = 30;

function probe(et) {
  const c = new Chassis(null);
  c.derive(
    metrics,
    {
      front: { rimInch: 19, j: 8.5, et, tireWidthMm: 255, aspect: 35 },
      rear: { rimInch: 19, j: 9.5, et: 31, tireWidthMm: 285, aspect: 30 },
    },
    real
  );
  const cs = c.cornerSpec();
  const g = (id) => cs.corners.find((k) => k.id === id).z;
  return { FL: g('FL'), FR: g('FR'), RL: g('RL') };
}

const pad = (v, n) => String(v).padStart(n);
const f4 = (v) => v.toFixed(4);

let fail = 0;
let pass = 0;
const ok = (m) => { console.log('  ✅ ' + m); pass++; };
const bad = (m) => { console.log('  ❌ ' + m); fail++; };

console.log('=== 1. ET 扫描：FL.z 应随 ET 减小而单调增大 ===');
const ets = [45, 40, 35, 30, 25, 20, 15, 10];
console.log('     ET(mm)   FL.z(m)    外凸量(mm)');
let prev = null;
let monotone = true;
const zs = {};
for (const et of ets) {
  const r = probe(et);
  zs[et] = r.FL;
  const out = OE_ET - et;
  if (prev !== null && r.FL < prev) monotone = false;
  console.log('     ' + pad(et, 2) + '      ' + f4(r.FL) + '      ' + pad(out, 4));
  prev = r.FL;
}
monotone
  ? ok('ET 从 45→10，FL.z 单调递增（轮子持续外凸）')
  : bad('FL.z 非单调 —— ET 未真实驱动轮位（可能回退成写死 halfTrack）');

console.log('\n=== 2. 原厂 ET 必须零位移（与改造前行为一致）===');
Math.abs(zs[OE_ET] - real.halfTrack_F) < 1e-9
  ? ok('ET' + OE_ET + ' → FL.z = ' + f4(zs[OE_ET]) + ' = halfTrack（零位移，向后兼容）')
  : bad('ET' + OE_ET + ' 时 FL.z=' + f4(zs[OE_ET]) + ' ≠ halfTrack=' + real.halfTrack_F);

console.log('\n=== 3. 位移量必须 1mm 对 1mm（无缩放误差）===');
const outBy10 = (zs[10] - zs[OE_ET]) * 1000;
const inBy45 = (zs[45] - zs[OE_ET]) * 1000;
Math.abs(outBy10 - 20) < 1e-6
  ? ok('ET10 外凸 ' + outBy10.toFixed(1) + 'mm（应 20）')
  : bad('ET10 外凸 ' + outBy10.toFixed(1) + 'mm，应为 20');
Math.abs(inBy45 + 15) < 1e-6
  ? ok('ET45 内缩 ' + inBy45.toFixed(1) + 'mm（应 -15）')
  : bad('ET45 内缩 ' + inBy45.toFixed(1) + 'mm，应为 -15');

console.log('\n=== 4. 左右严格镜像 ===');
const p = probe(25);
Math.abs(p.FR + p.FL) < 1e-9
  ? ok('ET25 时 FR=' + f4(p.FR) + ' = −FL=' + f4(-p.FL))
  : bad('左右不对称：FL=' + p.FL + ' FR=' + p.FR);

console.log('\n=== 5. 前后轴独立（改前轴 ET 不应影响后轴）===');
Math.abs(probe(10).RL - probe(45).RL) < 1e-9
  ? ok('前轴 ET 变化时 RL 保持恒定')
  : bad('后轴轮位被前轴 ET 污染');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
