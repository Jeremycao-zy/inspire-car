#!/usr/bin/env python3
"""_qa-roundtrip.py — 去背正确性的决定性验证：往返合成比对。

原理：如果 alpha = 255 - L 的反解是对的，那么把去背图**合成回纯白底**，
得到的结果应该和源图对应的裁切区域**逐像素几乎一致**。

    composite = 255*(1 - a/255) + 0*(a/255) = 255 - a
    而源图 observed = L，且 a = (255 - L - NOISE_FLOOR) * 255/(255-NOISE_FLOOR)

所以 composite 与 observed 的差，就是「去背损失」。逐像素统计最大/平均误差。

同时验证：
  1. 源图是否为纯灰度（决定 invert(1) 是否无损）—— 统计 RGB 通道最大偏差
  2. 去背图合成到**深色背景 + invert** 后是否会露出淡白雾（NOISE_FLOOR 是否够）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location(
    "_qa_pnglib", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "_qa-pnglib.py"))
_pnglib = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_pnglib)
load, px, lum, crop, save_png = (_pnglib.load, _pnglib.px, _pnglib.lum,
                                 _pnglib.crop, _pnglib.save_png)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "src", "assets")

print("=" * 72)
print("R-1. 源图灰度纯度（决定深色背景 invert(1) 是否无损）")
src = load(os.path.join(ASSETS, "logo-full.png"))
maxdev = 0
dev_hist = {}
over8 = 0
for y in range(0, src["h"], 1):
    for x in range(0, src["w"], 1):
        r, g, b, _ = px(src, x, y)
        d = max(r, g, b) - min(r, g, b)
        if d > maxdev:
            maxdev = d
        if d > 8:
            over8 += 1
        dev_hist[d] = dev_hist.get(d, 0) + 1
tot = src["w"] * src["h"]
print(f"  logo-full.png {src['w']}x{src['h']}")
print(f"  RGB 通道最大偏差 = {maxdev}（0=纯灰度）")
print(f"  偏差 >8 的像素 = {over8} ({over8 / tot * 100:.4f}%)")
print(f"  偏差分布(前6): {sorted(dev_hist.items())[:6]}")
print(f"  invert(1) 颜色保真: {'PASS' if maxdev <= 16 else 'FAIL 可能偏色'}")

print()
print("=" * 72)
print("R-2. 往返合成比对：去背图合成回白底 vs 源图对应裁切区")
MARK_BOX = dict(x0=337 - 2, y0=140 - 2, w=353, h=324)   # 与 make-logo-alpha 一致
FULL_BOX = dict(x0=251 - 2, y0=140 - 2, w=527, h=512)


def roundtrip(asset, box, label):
    a = load(os.path.join(ASSETS, asset))
    sx0, sy0, w, h = box["x0"], box["y0"], box["w"], box["h"]
    if (w, h) != (a["w"], a["h"]):
        print(f"  !! 尺寸不一致 asset={a['w']}x{a['h']} box={w}x{h}")
        return
    diffs = []
    worst = (0, None, None)
    for y in range(h):
        for x in range(w):
            _r, _g, _b, al = px(a, x, y)
            comp = 255 - al                      # 合成到纯白
            obs = lum(px(src, sx0 + x, sy0 + y))  # 源图观测亮度
            d = comp - obs
            diffs.append(d)
            if abs(d) > abs(worst[0]):
                worst = (d, (x, y), (comp, obs, al))
    n = len(diffs)
    mean = sum(diffs) / n
    meanabs = sum(abs(d) for d in diffs) / n
    mx = max(diffs)
    mn = min(diffs)
    p999 = sorted(abs(d) for d in diffs)[int(n * 0.999)]
    print(f"\n  [{label}] {asset} vs 源图 crop({sx0},{sy0},{w}x{h})")
    print(f"    像素数 = {n}")
    print(f"    误差 mean={mean:+.3f}  mean|d|={meanabs:.3f}  "
          f"min={mn}  max={mx}  P99.9|d|={p999}")
    print(f"    最差像素 @xy={worst[1]}  "
          f"composite={worst[2][0]} observed={worst[2][1]} alpha={worst[2][2]}")
    over = sum(1 for d in diffs if abs(d) > 10)
    print(f"    |误差|>10 的像素 = {over} ({over / n * 100:.4f}%)")
    verdict = "PASS（去背几乎无损）" if meanabs < 3 and p999 < 25 else \
              "WARN（存在可察觉偏差）"
    print(f"    判定: {verdict}")


roundtrip("logo-mark-nobg.png", MARK_BOX, "mark")
roundtrip("logo-full-nobg.png", FULL_BOX, "full")

print()
print("=" * 72)
print("R-3. NOISE_FLOOR 有效性：去背图合成到深色背景(#14171c)并 invert 后，")
print("     是否出现「淡白雾方块」")


def fog_test(asset, label, bg=(0x14, 0x17, 0x1c)):
    a = load(os.path.join(ASSETS, asset))
    w, h = a["w"], a["h"]
    bgl = lum(bg)
    # 模拟 CSS: 透明底黑线图 -> 合成到深色 bg -> filter invert(1)
    # 合成: c = bg*(1-a) + 0*a   (RGB 固定纯黑)
    # invert: c' = 255 - c
    # 背景处 a=0 -> c=bg -> c'=255-bg  (即 invert 后的背景)
    inv_bg = tuple(255 - v for v in bg)
    inv_bgl = lum(inv_bg)
    buckets = {"a==0 纯背景": 0, "a 1..5 极淡": 0, "a 6..25 淡雾": 0,
               "a 26..229 边缘": 0, "a>=230 实心线": 0}
    max_fog_delta = 0
    worst_fog = None
    for y in range(h):
        for x in range(w):
            _r, _g, _b, al = px(a, x, y)
            if al == 0:
                buckets["a==0 纯背景"] += 1
                continue
            # 合成后的 invert 亮度
            inv = tuple(255 - (bg[i] * (255 - al) // 255) for i in range(3))
            invl = lum(inv)
            delta = abs(invl - inv_bgl)
            if al <= 5:
                buckets["a 1..5 极淡"] += 1
                if delta > max_fog_delta:
                    max_fog_delta, worst_fog = delta, (x, y, al, invl, inv_bgl)
            elif al <= 25:
                buckets["a 6..25 淡雾"] += 1
            elif al <= 229:
                buckets["a 26..229 边缘"] += 1
            else:
                buckets["a>=230 实心线"] += 1
    tot = w * h
    print(f"\n  [{label}] {asset}  bg=rgb{bg} -> invert 后背景亮度={inv_bgl}")
    for k, v in buckets.items():
        print(f"    {k:16s}: {v:7d}  ({v / tot * 100:6.3f}%)")
    print(f"    极淡区(a1..5)相对背景的最大亮度抬升 = {max_fog_delta}"
          f"  worst={worst_fog}")
    print(f"    可见白雾判定: "
          f"{'PASS 无可见雾' if max_fog_delta <= 6 else 'FAIL 有淡白雾'}")


fog_test("logo-mark-nobg.png", "mark")
fog_test("logo-full-nobg.png", "full")

print()
print("=" * 72)
print("R-4. logo-mark-nobg 内部结构：确认只有徽标、不含字标残片")
m = load(os.path.join(ASSETS, "logo-mark-nobg.png"))
rows = []
for y in range(m["h"]):
    rows.append(sum(1 for x in range(m["w"]) if px(m, x, y)[3] > 8))
bands = []
st = None
for y, c in enumerate(rows):
    if c > 0 and st is None:
        st = y
    elif c == 0 and st is not None:
        bands.append((st, y - 1)); st = None
if st is not None:
    bands.append((st, len(rows) - 1))
print(f"  mark 的含墨 y 区间: {bands}  -> "
      f"{'PASS 单段=纯徽标' if len(bands) == 1 else 'WARN 多段'}")
for i, (a, b) in enumerate(bands):
    minx, maxx = m["w"], -1
    for y in range(a, b + 1):
        for x in range(m["w"]):
            if px(m, x, y)[3] > 8:
                minx = min(minx, x); maxx = max(maxx, x)
    print(f"    band{i}: y[{a}..{b}] h={b - a + 1}px  x[{minx}..{maxx}] "
          f"w={maxx - minx + 1}px")

print()
print("R-5. logo-full-nobg 字标段结构")
f = load(os.path.join(ASSETS, "logo-full-nobg.png"))
for (a, b) in [(2, 321), (436, 509)]:
    minx, maxx = f["w"], -1
    for y in range(a, b + 1):
        for x in range(f["w"]):
            if px(f, x, y)[3] > 8:
                minx = min(minx, x); maxx = max(maxx, x)
    print(f"    y[{a}..{b}] h={b - a + 1}px  x[{minx}..{maxx}] "
          f"w={maxx - minx + 1}px")
print(f"    徽标底(y=321) 到 字标顶(y=436) 之间的空白 = {436 - 321 - 1}px"
      f"  (占全图 {(436 - 321 - 1) / 512 * 100:.1f}%)")
