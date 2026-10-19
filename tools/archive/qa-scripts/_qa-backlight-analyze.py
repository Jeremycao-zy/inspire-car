#!/usr/bin/env python3
"""
_qa-backlight-analyze.py — 背光面可见性的量化分析（临时脚本，非产物）

输入：_qa-backlight.mjs 拍的 A/B 图对
  A = 车可见       B = 车壳 + 车轮全部隐藏
两张相减得到「车占据的像素」，统计这些像素的亮度分布。

判据（对应用户诉求「背光面看得清」）：
  · nearBlack%  = 亮度 < 12/255 的车壳像素占比 —— 越小越好
  · p05         = 车壳像素亮度的 5 分位      —— 越大越好（暗部被抬起来了）
  · mean        = 车壳像素平均亮度

用法：python3 scripts/_qa-backlight-analyze.py /tmp
"""
import sys
import os
import glob
import json
from PIL import Image

SIDEBAR = 348          # 侧栏宽度，统计时排除
DIFF_TH = 12           # A/B 差异阈值，超过即认为是车占据的像素
NEAR_BLACK = 12        # 「近黑」阈值


def lum(px):
    return 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]


def analyze(a_path, b_path):
    A = Image.open(a_path).convert('RGB')
    B = Image.open(b_path).convert('RGB')
    if A.size != B.size:
        return None
    w, h = A.size
    pa = A.load()
    pb = B.load()

    vals = []
    for y in range(0, h, 2):                 # 隔行采样，够用且快
        for x in range(SIDEBAR, w, 2):
            ca = pa[x, y]
            cb = pb[x, y]
            d = abs(ca[0] - cb[0]) + abs(ca[1] - cb[1]) + abs(ca[2] - cb[2])
            if d < DIFF_TH * 3:
                continue                      # 背景，不是车
            vals.append(lum(ca))
    if len(vals) < 500:
        return None
    vals.sort()
    n = len(vals)
    mean = sum(vals) / n
    p05 = vals[int(n * 0.05)]
    p25 = vals[int(n * 0.25)]
    p50 = vals[int(n * 0.50)]
    near = sum(1 for v in vals if v < NEAR_BLACK)
    return {
        'n': n,
        'mean': round(mean, 1),
        'p05': round(p05, 1),
        'p25': round(p25, 1),
        'p50': round(p50, 1),
        'nearBlackPct': round(near / n * 100, 2),
    }


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
    pairs = sorted(glob.glob(os.path.join(d, 'bl-*-A.png')))
    if not pairs:
        print('没有找到 bl-*-A.png，先跑 scripts/_qa-backlight.mjs')
        return 1

    rows = []
    for a in pairs:
        b = a.replace('-A.png', '-B.png')
        if not os.path.exists(b):
            continue
        key = os.path.basename(a)[3:-6]       # bl-<preset>-<angle>-A.png
        preset, angle = key.rsplit('-', 1)
        r = analyze(a, b)
        if r is None:
            print(f'  {preset:10s} {angle:14s} 样本不足，跳过')
            continue
        rows.append({'preset': preset, 'angle': angle, **r})

    print('\n车壳像素亮度统计（0–255；越大 = 背光面越看得清）')
    print('  场景        机位           像素数   平均   5分位  25分位  50分位   近黑%')
    for r in rows:
        print(
            f"  {r['preset']:10s}  {r['angle']:14s} {r['n']:7d}  "
            f"{r['mean']:5.1f}  {r['p05']:5.1f}  {r['p25']:6.1f}  {r['p50']:6.1f}  "
            f"{r['nearBlackPct']:6.2f}"
        )

    out = os.path.join(d, 'bl-report.json')
    with open(out, 'w') as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print(f'\n详细数据：{out}')

    worst_nb = max(r['nearBlackPct'] for r in rows)
    worst_p05 = min(r['p05'] for r in rows)
    print(f'\n最差近黑占比 = {worst_nb:.2f}%   最差 5 分位亮度 = {worst_p05:.1f}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
