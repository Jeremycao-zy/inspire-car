/**
 * reframe-guides.mjs — 车型拍摄示意图重新构图（居中 + 等比 + 统一留白）
 *
 * 问题（用户 2026-10-15 反馈截图）：
 *   ① 车没居中：front 偏右 38px、rear 偏左 50px
 *   ② **5 张图尺寸不统一**：车体宽 508 ~ 890px，side 快贴到虚线安全框了
 *   ③ 垂直全部偏上 14~21px
 *   → 用户看到像 5 台不同的车，而不是同一台车的 5 个角度
 *
 * 做法（纯像素处理，不重新渲染，不需要 3D 管线）：
 *   1. 按背景色差分测出车体精确 bbox（含阴影 → 需按阈值剔除软阴影）
 *   2. 取 5 张图的**统一缩放比** = min(各图可用宽/车体宽)，保证大的不被裁、小的不被放大过头
 *   3. 缩放后按 bbox 中心**精确居中**贴到统一留白的画布上
 *   4. 输出到 public/guides/，保持 1024×1024、背景色不变
 *
 * 留白口径：安全框是 7% 内缩（photoGuide.css 的 --safe-inset），
 *   再留 6% 额外余量 → 车体外接框控制在画布 80% 以内，任何视口下都不出框。
 *
 * 用法：node scripts/reframe-guides.mjs [--dry]
 */
import { PNG } from '/Users/jeremysmac/.workbuddy/binaries/node/workspace/node_modules/pngjs/lib/png.js';
import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = ['front', 'front-right', 'side', 'rear', 'rear-right'];
const DIR = 'public/guides';

/**
 * 车体外接框最多可占画布的比例。
 * 取景框是 aspect-ratio 4/3，ghost 用 object-fit:cover —— 所以示意图也必须是 4:3，
 * 否则方形图会被裁掉上下 25%，"在方形画布里居中" ≠ "在可见框里居中"。
 * 0.86 = 安全框 7% 内缩刚好贴边，这里再留 2% 余量，保证不出框。
 */
const TARGET_FILL = 0.84;
/**
 * 车体测量：**列/行密度法**，把地面软阴影排除在外。
 *
 * 为什么不能用亮度阈值：实测把阈值从 26 提到 100，车身 bbox 只缩 6px ——
 * 渲染出的地面阴影和车身一样暗，亮度根本分不开（用户截图里"车看着偏"就是它造成的）。
 *
 * 改用密度：车身所在列有大量连续暗像素；阴影只是地面一片薄暗区，
 * 列内暗像素数远少于车身。取「列计数 ≥ 峰值 × DENSITY_FRAC」两侧边界即为车身。
 * 实测 rear.png：15% 仍含阴影（宽 523），25%~50% 稳定落在真车身（宽 387~394），
 * 取 40% —— 再高会切掉侧视图的车头/车尾（保险杠端部竖直像素较少）。
 */
const CAR_THRESHOLD = 30;
const DENSITY_FRAC = 0.4;

function measure(png) {
  const { width: W, height: H, data } = png;
  const bg = [data[0], data[1], data[2]];
  const colC = new Int32Array(W);
  const rowC = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) > CAR_THRESHOLD) { colC[x]++; rowC[y]++; }
    }
  }
  const span = (arr) => {
    const mx = Math.max(...arr);
    let a = -1, b2 = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] >= mx * DENSITY_FRAC) { if (a < 0) a = i; b2 = i; }
    }
    return [a, b2];
  };
  const [minX, maxX] = span(colC);
  const [minY, maxY] = span(rowC);
  return { minX, maxX, minY, maxY, bg, W, H };
}

/** 双线性缩放采样（3x3 降采样抗锯齿） */
const SS = 3;

/** 裁出 bbox 区域并缩放，返回可贴回的新 RGBA 缓冲 */
function cropScale(png, box, scale) {
  const { data, width: W, height: H } = png;
  const bw = box.maxX - box.minX + 1;
  const bh = box.maxY - box.minY + 1;
  const ow = Math.round(bw * scale);
  const oh = Math.round(bh * scale);
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      // 目标像素中心 → 源坐标，做 SS×SS 均值采样
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const sx0 = box.minX + (ox / scale);
      const sy0 = box.minY + (oy / scale);
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = Math.min(W - 1, Math.max(0, Math.round(sx0 + (sx / SS) * (scale ? 1 / scale : 0))));
          const py = Math.min(H - 1, Math.max(0, Math.round(sy0 + (sy / SS) * (scale ? 1 / scale : 0))));
          const i = (py * W + px) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
          n++;
        }
      }
      const o = (oy * ow + ox) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { buf: out, w: ow, h: oh };
}

const dry = process.argv.includes('--dry');
const W = 1024, H = 768;   // 4:3，与取景框一致

// ---- 1. 测量全部 ----
const measured = NAMES.map((name) => {
  const png = PNG.sync.read(readFileSync(`${DIR}/${name}.png`));
  const box = measure(png);
  const bw = box.maxX - box.minX + 1;
  const bh = box.maxY - box.minY + 1;
  return { name, png, box, bw, bh };
});

console.log('=== 原始测量 ===');
for (const m of measured) {
  const cx = (m.box.minX + m.box.maxX) / 2;
  const cy = (m.box.minY + m.box.maxY) / 2;
  console.log(
    `  ${m.name.padEnd(13)} 车体 ${String(m.bw).padStart(4)}x${String(m.bh).padStart(4)}` +
    `  中心偏移(${String(Math.round(cx - W / 2)).padStart(4)},${String(Math.round(cy - H / 2)).padStart(4)})`
  );
}

// ---- 2. 统一缩放：取所有图里最"紧"的那张（最小缩放比），保证都不裁 ----
const fillW = W * TARGET_FILL;
const fillH = H * TARGET_FILL;
const scale = Math.min(...measured.map((m) => Math.min(fillW / m.bw, fillH / m.bh)));
console.log(`\n统一缩放比 = ${scale.toFixed(4)}（由最紧的一张决定，保证任何角度都不被裁）`);

// ---- 3. 逐张重构 ----
console.log('\n=== 重构结果 ===');
for (const m of measured) {
  const { buf, w, h } = cropScale(m.png, m.box, scale);
  const out = new PNG({ width: W, height: H });
  // 填背景
  const [br, bg2, bb] = m.box.bg;
  for (let i = 0; i < W * H; i++) {
    out.data[i * 4] = br; out.data[i * 4 + 1] = bg2; out.data[i * 4 + 2] = bb; out.data[i * 4 + 3] = 255;
  }
  // 精确居中：左边距 = (W - w)/2，上边距 = (H - h)/2
  const ox = Math.round((W - w) / 2);
  const oy = Math.round((H - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = ((y + oy) * W + (x + ox)) * 4;
      const a = buf[si + 3] / 255;
      // alpha 混合到背景上，避免边缘出现背景色方块
      out.data[di] = buf[si] * a + br * (1 - a);
      out.data[di + 1] = buf[si + 1] * a + bg2 * (1 - a);
      out.data[di + 2] = buf[si + 2] * a + bb * (1 - a);
      out.data[di + 3] = 255;
    }
  }
  console.log(
    `  ${m.name.padEnd(13)} → ${w}x${h}  留白 左${String(ox).padStart(3)} 右${String(W - ox - w).padStart(3)}` +
    ` 上${String(oy).padStart(3)} 下${String(H - oy - h).padStart(3)}  边距/边=${((ox / W) * 100).toFixed(1)}%`
  );
  if (!dry) {
    writeFileSync(`${DIR}/${m.name}.png`, PNG.sync.write(out));
  }
}

console.log(dry ? '\n[dry-run] 未写盘' : '\n✅ 5 张示意图已重新构图');
