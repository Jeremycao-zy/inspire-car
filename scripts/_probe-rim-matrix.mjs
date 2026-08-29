/**
 * _probe-rim-matrix.mjs — 精度「极限档」探顶矩阵（faceCount × 输入分辨率）
 *
 * ⚠️ 本脚本**会真实消耗混元 3D 额度**，默认不自动运行。
 *    由工程师 / QA 在「上线前」手动跑，按判据固化 extreme 档取值：
 *      判据 = 100% 成功 + 单任务 ≤ 8min + 导出 GLB 在 THREE 中无破面。
 *    跑完后把结论回填到 src/api/generate.js 的 PRECISION_TIERS.extreme
 *    与 server/index.mjs 的 PRECISION_TIERS，并将 main.js 默认 precision 升 extreme。
 *
 * 关于「分辨率」：混元 3D 接收的是压缩后的输入图，分辨率由前端
 *   src/api/generate.js 的 shrinkImage(maxSide) 控制（后端不二次处理）。
 *   本脚本直接把图以 base64 发给 /api/generate 并显式带 faceCount，故「分辨率」
 *   维度需要由调用方提供对应尺寸的源图：
 *      --img-2048 <path>   用于 2048 列的高清源图（≤2048 长边）
 *      --img-4096 <path>   用于 4096 列的高清源图（≥4096 长边，若未提供则复用 2048 图）
 *   若只传 --image，则两列都用同一张图，仅 faceCount 维度真实变化（分辨率维度标记为 N/A）。
 *
 * 用法示例（需先 export HUNYUAN3D_TOKEN 或写 ~/.workbuddy/tokens/hunyuan3d）：
 *   node scripts/_probe-rim-matrix.mjs --image ./wheel.jpg --img-4096 ./wheel-4k.jpg
 *
 * 退出码：全部组合成功 0；存在失败 1（便于 CI 判据）。
 */

import fs from 'node:fs';
import path from 'node:path';

const API_URL = process.env.PROBE_API_URL || 'http://127.0.0.1:8787/api/generate';
const FACE_COUNTS = [200000, 250000, 300000, 350000];
const RESOLUTIONS = [2048, 4096];

/* ---------------- 参数解析 ---------------- */
const args = process.argv.slice(2);
function getArg(name, def = undefined) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const image2048 = getArg('--img-2048') || getArg('--image');
const image4096 = getArg('--img-4096') || image2048;
const imgPath = getArg('--image');
const timeoutMs = Number(getArg('--timeout', '540000')); // 单任务上限 9min（判据 ≤8min）

if (!imgPath) {
  console.error('用法：node scripts/_probe-rim-matrix.mjs --image <wheel.jpg> [--img-4096 <4k.jpg>]');
  process.exit(2);
}

function readImageB64(p) {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/* ---------------- SSE 提交与轮询 ---------------- */

async function submitOnce({ faceCount, dataUrl }) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        kind: 'wheel',
        images: [{ name: 'probe.jpg', dataUrl }],
        faceCount,
        model: '3.1',
        prompt: 'a single alloy car wheel rim, rim only, no tire, no car, isolated',
      }),
    });
    if (!res.ok || !res.body) {
      return { ok: false, stage: 'http', message: `HTTP ${res.status}`, ms: Date.now() - started };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (['auth_error', 'error', 'timeout'].includes(payload.stage)) {
          return { ok: false, stage: payload.stage, message: payload.message || '', ms: Date.now() - started };
        }
        if (payload.stage === 'done' && payload.result) {
          return { ok: true, stage: 'done', ms: Date.now() - started, url: payload.result.url };
        }
      }
    }
    return { ok: false, stage: 'eof', message: '流意外结束', ms: Date.now() - started };
  } catch (e) {
    return { ok: false, stage: 'exception', message: String(e.message || e), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 主流程 ---------------- */

console.log(`\n═══════ 探顶矩阵：faceCount × 分辨率 ═══════`);
console.log(`API: ${API_URL}  单任务超时: ${Math.round(timeoutMs / 60000)}min`);
console.log(`2048 源图: ${image2048 || '(无)'}`);
console.log(`4096 源图: ${image4096 || '(复用 2048)'}\n`);

const results = [];
let allOk = true;

for (const fc of FACE_COUNTS) {
  for (const res of RESOLUTIONS) {
    const src = res === 4096 ? image4096 : image2048;
    if (!src) {
      results.push({ fc, res, ok: false, stage: 'skip', message: '缺少该分辨率源图', ms: 0 });
      allOk = false;
      continue;
    }
    const dataUrl = readImageB64(src);
    process.stdout.write(`  · faceCount=${fc}  res=${res} … `);
    const r = await submitOnce({ faceCount: fc, dataUrl });
    const tag = r.ok ? '✅' : '❌';
    console.log(`${tag} ${r.ok ? `${(r.ms / 1000).toFixed(0)}s` : `${r.stage}: ${r.message}`}`);
    results.push({ fc, res, ...r });
    if (!r.ok) allOk = false;
  }
}

/* ---------------- 汇总表 ---------------- */

console.log('\n──────── 矩阵汇总 ────────');
console.log('faceCount \\ res |  2048  |  4096');
for (const fc of FACE_COUNTS) {
  const cells = RESOLUTIONS.map((res) => {
    const r = results.find((x) => x.fc === fc && x.res === res);
    if (!r) return '   -   ';
    if (r.ok) return `${(r.ms / 1000).toFixed(0).padStart(4)}s`.padEnd(7);
    return (r.stage || 'fail').slice(0, 6).padEnd(7);
  });
  console.log(`${String(fc).padEnd(13)} | ${cells.join(' | ')}`);
}

console.log('\n判据（建议 extreme 取值）：100% 成功 + 单任务 ≤ 8min + 导出 GLB 无破面。');
if (allOk) {
  console.log('✅ 全部组合成功（仍需人工复核 GLB 破面）。');
  process.exit(0);
} else {
  console.log('❌ 存在失败组合，请勿将失败组合作为 extreme 固化值。');
  process.exit(1);
}
