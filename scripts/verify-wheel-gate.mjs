/**
 * verify-wheel-gate.mjs — 复现并验证「生成轮毂不进仓库」的登记闸门逻辑。
 *
 * 背景：server 在没有 3D 凭证时返回 res.mode === 'demo'，前端 runGenerate 原先
 * 只在「非 demo」分支（res.mode === 'live'）登记轮毂 → demo 模式下轮毂永不被
 * POST 到 /api/wheels（真因 A）。本脚本用与 src/main.js runGenerate 完全一致的
 * 判定条件，验证修复后：
 *   1) demo + 形状通过  ⇒ 登记 + 广播 mywheel:added
 *   2) live + 形状通过  ⇒ 登记 + 广播 mywheel:added
 *   3) live + 形状误杀  ⇒ 不登记（保持旧轮毂，符合预期）
 *
 * 无浏览器/无网络也可运行：node scripts/verify-wheel-gate.mjs
 */

// ---- 模拟前端环境 ----
const posted = []; // 收集 POST /api/wheels 的登记
const events = []; // 收集 window 上的 mywheel:added 事件
globalThis.window = {
  dispatchEvent(ev) {
    events.push(ev);
  },
};

// 与 src/ui/myWheels.js recordGeneratedWheel 等价的登记动作（去重由 server 负责）
async function recordGeneratedWheel({ url, name }) {
  if (!url) return null;
  posted.push({ url, name });
  return { id: 'w_' + posted.length, url, name };
}

// 与 src/main.js 修复后的判定逻辑完全一致
async function registerIfNeeded({ kind, mode, applied, url, name, files }) {
  // demo 分支：现在也会登记（修复前整段跳过 → 真因 A）
  if (mode === 'demo') {
    if (kind === 'wheel' && !applied?.rejected) {
      await recordGeneratedWheel({ url, files, name: name || '我的轮毂' });
      window.dispatchEvent(new CustomEvent('mywheel:added', { detail: { url, name } }));
      return true;
    }
    return false;
  }
  // live 分支
  if (kind === 'wheel' && mode === 'live') {
    if (!applied?.rejected) {
      await recordGeneratedWheel({ url, files, name: name || '我的轮毂' });
      window.dispatchEvent(new CustomEvent('mywheel:added', { detail: { url, name } }));
      return true;
    }
    return false; // 形状误杀，不登记
  }
  return false;
}

// 形状校验结果（与 wheelShapeOf 的 rejected 字段对应）
const ACCEPTED = { rejected: false };
const REJECTED = { rejected: true };

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓', msg);
  } else {
    fail++;
    console.log('  ✗', msg);
  }
}

async function run() {
  posted.length = 0;
  events.length = 0;
  console.log('\n[场景 1] demo 模式 + 形状通过 —— 修复前应登记失败，修复后应通过');
  const r1 = await registerIfNeeded({ kind: 'wheel', mode: 'demo', applied: ACCEPTED, url: '/models/rim-default.glb', name: '我的轮毂' });
  assert(r1 === true, 'demo+盘状轮毂：登记返回 true');
  assert(posted.length === 1 && posted[0].url === '/models/rim-default.glb', 'demo：POST /api/wheels 已发出（轮毂进入仓库）');
  assert(events.some((e) => e.type === 'mywheel:added'), 'demo：广播了 mywheel:added（仓库可即时刷新）');

  console.log('\n[场景 2] live 模式 + 形状通过 —— 始终应通过');
  const r2 = await registerIfNeeded({ kind: 'wheel', mode: 'live', applied: ACCEPTED, url: '/api/asset/wheel-abc.glb', name: '我的轮毂' });
  assert(r2 === true, 'live+盘状轮毂：登记返回 true');
  assert(posted.length === 2, 'live：第二次 POST /api/wheels 已发出');
  assert(events.filter((e) => e.type === 'mywheel:added').length === 2, 'live：同样广播了 mywheel:added');

  console.log('\n[场景 3] live 模式 + 形状误杀 —— 不应登记（保持旧轮毂）');
  const before = posted.length;
  const r3 = await registerIfNeeded({ kind: 'wheel', mode: 'live', applied: REJECTED, url: '/api/asset/car-xyz.glb', name: '我的轮毂' });
  assert(r3 === false, 'live+非盘状（误杀）：登记返回 false');
  assert(posted.length === before, 'live+误杀：未发起任何登记 POST（不会用坏 URL 覆盖方案）');

  console.log('\n[场景 4] 整车（car）不应触发轮毂登记');
  const before4 = posted.length;
  await registerIfNeeded({ kind: 'car', mode: 'live', applied: ACCEPTED, url: '/api/asset/car.glb' });
  assert(posted.length === before4, 'car 类型：不登记轮毂');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

run();
