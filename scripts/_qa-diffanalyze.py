#!/usr/bin/env python3
"""_qa-diffanalyze.py — 分析差分截图，隔离出 logo 的真实渲染足迹。

对每组 (A, A2, B)：
  控制差 = |A - A2|   -> 画面自身噪声底
  测试差 = |A - B|    -> logo 的贡献
按 max(通道差) 逐像素统计，给出 bbox / 最大对比 / 分级墨量。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util as _ilu
_sp = _ilu.spec_from_file_location(
    "_qa_pnglib", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "_qa-pnglib.py"))
PL = _ilu.module_from_spec(_sp)
_sp.loader.exec_module(PL)
load, px, lum, save_png = PL.load, PL.px, PL.lum, PL.save_png

DIR = '/tmp/_qa/diff'
META = json.load(open(os.path.join(DIR, 'meta.json')))

GROUPS = [
    ('auth20',  '登录卡 20px (浅底·不反相)', 'authCard20'),
    ('garage26', '车库 header 26px (浅底·不反相)', 'garage26'),
    ('garage19', '窄屏车库 19px (浅底·不反相)', 'garage19'),
    ('appbar18', '顶栏 18px (深色·invert)', 'appbar18'),
    ('wm15',     '3D 水印 15px (深色·invert·opacity.35)', 'watermark15'),
    ('ov160',    '加载遮罩 160px (深色·invert)', 'overlay160'),
    ('ov120',    '窄屏遮罩 120px (深色·invert)', 'overlay120'),
]

print('=' * 78)
print('差分分析：logo 的真实渲染足迹（与背景无关）')
print('=' * 78)

summary = {}

for gname, label, metakey in GROUPS:
    pa, pa2, pb = (os.path.join(DIR, f'{gname}-A.png'),
                   os.path.join(DIR, f'{gname}-A2.png'),
                   os.path.join(DIR, f'{gname}-B.png'))
    if not (os.path.exists(pa) and os.path.exists(pb)):
        print(f'\n[{label}] 缺文件，跳过')
        continue
    A = load(pa); A2 = load(pa2) if os.path.exists(pa2) else None; B = load(pb)
    if (A['w'], A['h']) != (B['w'], B['h']):
        print(f'\n[{label}] 尺寸不一致 {A["w"]}x{A["h"]} vs {B["w"]}x{B["h"]}，跳过')
        continue
    w, h = A['w'], A['h']

    def diffmap(X, Y):
        m = [[0] * w for _ in range(h)]
        for y in range(h):
            for x in range(w):
                a = px(X, x, y); b = px(Y, x, y)
                m[y][x] = max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]))
        return m

    ctl = diffmap(A, A2) if A2 else None
    tst = diffmap(A, B)
    noise = max(max(r) for r in ctl) if ctl else 0
    ctrl_nonzero = sum(1 for r in ctl for v in r if v > 2) if ctl else 0

    gate = max(noise, 6)
    minx, miny, maxx, maxy = w, h, -1, -1
    mx = 0
    buckets = {'>=8': 0, '>=20': 0, '>=40': 0, '>=80': 0, '>=140': 0}
    for y in range(h):
        for x in range(w):
            d = tst[y][x]
            if d > mx: mx = d
            for k, t in (('>=8', 8), ('>=20', 20), ('>=40', 40),
                         ('>=80', 80), ('>=140', 140)):
                if d >= t: buckets[k] += 1
            if d > gate:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y

    info = META.get(metakey, {}).get('info', {})
    print(f'\n--- {label} ---')
    print(f'  截图 {w}x{h}   padding 已含在截图内')
    print(f'  DOM: cssH={info.get("cssH")} cssW={info.get("cssW")} '
          f'rect={info.get("w", 0):.1f}x{info.get("h", 0):.1f} '
          f'nat={info.get("nat")} filter={info.get("filter")} '
          f'opacity={info.get("opacity")} 父opacity={info.get("parentOpacity")}')
    print(f'  噪声底(控制差 A vs A2) = {noise}   非零(>2)控制像素 = {ctrl_nonzero}')
    print(f'  logo 最大对比度 = {mx}/255')
    if maxx >= 0:
        bw, bh = maxx - minx + 1, maxy - miny + 1
        print(f'  logo 足迹 bbox = x[{minx}..{maxx}] y[{miny}..{maxy}] = {bw}x{bh}px')
        print(f'  (参考 DOM rect 高 {info.get("h", 0):.2f}px)  '
              f'足迹高/DOM高 = {bh / max(info.get("h", 1), 0.01) * 100:.1f}%')
    else:
        bw = bh = 0
        print('  logo 足迹 bbox = 空（完全不可见！）')
    tot = w * h
    print(f'  分级像素数: ' + '  '.join(
        f'{k}:{v}({v / tot * 100:4.1f}%)' for k, v in buckets.items()))

    # 逐行墨量剖面（用 >=20 的像素数），看是否「糊成一团」
    if maxx >= 0:
        rows = []
        for y in range(miny, maxy + 1):
            rows.append((y, sum(1 for x in range(minx, maxx + 1) if tst[y][x] >= 20)))
        cols = []
        for x in range(minx, maxx + 1):
            cols.append((x, sum(1 for y in range(miny, maxy + 1) if tst[y][x] >= 20)))
        print(f'  行剖面(y:count) = {rows}')
        # 可辨性判据：至少有一行/一列的实心像素数明显 > 1（有结构，不是一坨）
        rowmax = max(c for _, c in rows)
        colmax = max(c for _, c in cols)
        gaps_r = sum(1 for _, c in rows if c == 0)
        gaps_c = sum(1 for _, c in cols if c == 0)
        print(f'  行最大实心数={rowmax} 列最大实心数={colmax}  '
              f'内部空行={gaps_r} 内部空列={gaps_c}')
        clear = mx >= 90 and buckets['>=40'] >= 8 and (gaps_r + gaps_c) >= 1
        print(f'  清晰度判定: {"PASS 有结构、对比足" if clear else "WARN 对比不足或糊成一团"}')
    else:
        clear = False
        print('  清晰度判定: FAIL 不可见')

    summary[gname] = dict(label=label, noise=noise, maxDiff=mx,
                          bbox=(minx, miny, maxx, maxy), inkW=bw, inkH=bh,
                          buckets=buckets, clear=bool(clear),
                          domH=info.get('h'), cssH=info.get('cssH'),
                          filter=info.get('filter'),
                          opacity=info.get('opacity'),
                          parentOpacity=info.get('parentOpacity'))

    # 导出「logo 足迹」可视化 PNG（把差值放大到 0..255 灰度）
    vis = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            d = tst[y][x]
            i = (y * w + x) * 4
            vis[i] = vis[i + 1] = vis[i + 2] = min(255, d * 3)
            vis[i + 3] = 255
    save_png(os.path.join(DIR, f'{gname}-FOOTPRINT.png'), w, h, vis)

print('\n' + '=' * 78)
json.dump(summary, open(os.path.join(DIR, 'summary.json'), 'w'),
          ensure_ascii=False, indent=2)
print('summary.json 已写出')
