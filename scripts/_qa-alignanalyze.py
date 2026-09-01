#!/usr/bin/env python3
"""_qa-alignanalyze.py — 从差分图里量出 logo 与标题各自的真实墨迹高度。"""
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
load, px = PL.load, PL.px

DIR = '/tmp/_qa/align'
META = json.load(open(os.path.join(DIR, 'meta.json')))


def diffmap(X, Y):
    w, h = X['w'], X['h']
    m = [[0] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            a = px(X, x, y); b = px(Y, x, y)
            m[y][x] = max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]))
    return m


def extent(m, thr):
    h = len(m); w = len(m[0])
    minx, miny, maxx, maxy = w, h, -1, -1
    n = 0
    mx = 0
    for y in range(h):
        for x in range(w):
            d = m[y][x]
            if d > mx: mx = d
            if d >= thr:
                n += 1
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        return None, 0, mx
    return (minx, miny, maxx, maxy), n, mx


def profile_rows(m, box, thr):
    x0, y0, x1, y1 = box
    return [(y, sum(1 for x in range(x0, x1 + 1) if m[y][x] >= thr))
            for y in range(y0, y1 + 1)]


print('=' * 78)
print('B. 尺寸对齐 —— 差分隔离后的真实墨迹测量')
print('=' * 78)

results = {}
for tag in ('w1280', 'w1280sub', 'w800'):
    sc = META.get(tag)
    if not sc or 'err' in sc or 'clip' not in sc:
        print(f'\n[{tag}] 无数据')
        continue
    geo = sc['geo']; clip = sc['clip']
    A = load(os.path.join(DIR, f'{tag}-A.png'))
    Bl = load(os.path.join(DIR, f'{tag}-Blogo.png'))
    Bt = load(os.path.join(DIR, f'{tag}-Btext.png'))

    dlogo = diffmap(A, Bl)
    dtext = diffmap(A, Bt)

    print(f'\n{"-" * 74}')
    print(f'[{tag}]  文字="{geo["textContent"]}"  font-size={geo["fontSize"]}  '
          f'font={geo["fontFamily"]}  logo CSS height={geo["logoCssH"]}')
    print(f'  DOM: logo rect y[{geo["logo"]["y"]:.2f} .. '
          f'{geo["logo"]["y"] + geo["logo"]["h"]:.2f}] h={geo["logo"]["h"]:.2f}')
    print(f'  DOM: 文字 range y[{geo["text"]["y"]:.2f} .. '
          f'{geo["text"]["y"] + geo["text"]["h"]:.2f}] h={geo["text"]["h"]:.2f}')

    for thr in (8, 20, 45):
        bl, nl, ml = extent(dlogo, thr)
        bt, nt, mt = extent(dtext, thr)
        if not bl or not bt:
            print(f'  thr>={thr:2d}: 一侧未检到 (logo={bl} text={bt})')
            continue
        lh = bl[3] - bl[1] + 1
        th = bt[3] - bt[1] + 1
        lc = (bl[1] + bl[3]) / 2
        tc = (bt[1] + bt[3]) / 2
        print(f'  thr>={thr:2d}: logo 墨迹高 {lh:2d}px (y[{bl[1]}..{bl[3]}], '
              f'{nl:4d}px) | 文字墨迹高 {th:2d}px (y[{bt[1]}..{bt[3]}], {nt:4d}px) '
              f'| 差 {lh - th:+d}px ({lh / th * 100:.0f}%)')
        print(f'          中心线 logo={lc:.1f} 文字={tc:.1f} '
              f'垂直错位={lc - tc:+.1f}px (正=logo 偏下)')
        if thr == 8:
            results[tag] = dict(logo_ink=lh, text_ink=th, diff=lh - th,
                                ratio=lh / th * 100,
                                logo_y=(bl[1], bl[3]), text_y=(bt[1], bt[3]),
                                logo_c=lc, text_c=tc, offset=lc - tc,
                                fontSize=geo['fontSize'],
                                logoCssH=geo['logoCssH'],
                                maxdiff_logo=ml, maxdiff_text=mt)
    # 详细行剖面（thr>=8）
    bl, _, _ = extent(dlogo, 8)
    bt, _, _ = extent(dtext, 8)
    if bl:
        print(f'  logo 行剖面(thr8): {profile_rows(dlogo, bl, 8)}')
    if bt:
        pr = profile_rows(dtext, bt, 8)
        print(f'  文字行剖面(thr8): {pr}')

print('\n' + '=' * 78)
json.dump(results, open(os.path.join(DIR, 'align.json'), 'w'),
          ensure_ascii=False, indent=2)
print(json.dumps(results, ensure_ascii=False, indent=2))
