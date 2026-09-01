#!/usr/bin/env python3
"""_qa-ratiosanalyze.py — 登录卡 / 顶栏 / 水印 三处的 logo vs 标题 墨迹比例。"""
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

DIR = '/tmp/_qa/ratios'
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
    n = 0; mx = 0
    for y in range(h):
        for x in range(w):
            d = m[y][x]
            if d > mx: mx = d
            if d >= thr:
                n += 1
                minx = min(minx, x); maxx = max(maxx, x)
                miny = min(miny, y); maxy = max(maxy, y)
    if maxx < 0:
        return None, 0, mx
    return (minx, miny, maxx, maxy), n, mx


LABEL = {'auth': '登录卡', 'appbar': '顶栏', 'wm': '3D 水印'}
print('=' * 78)
print('其余三处：logo 墨迹高 vs 相邻标题墨迹高')
print('=' * 78)

res = {}
for tag in ('auth', 'appbar', 'wm'):
    sc = META.get(tag)
    if not sc or 'clip' not in sc:
        print(f'\n[{tag}] 无数据: {sc}')
        continue
    geo = sc['geo']
    A = load(os.path.join(DIR, f'{tag}-A.png'))
    Bl = load(os.path.join(DIR, f'{tag}-Bl.png'))
    Bt = load(os.path.join(DIR, f'{tag}-Bt.png'))
    dl = diffmap(A, Bl)
    dt = diffmap(A, Bt)

    print(f'\n--- {LABEL[tag]}  {tag} ---')
    print(f'  标题文字 = "{geo.get("text")}"  font-size={geo.get("fontSize")}  '
          f'family={geo.get("family")}')
    print(f'  logo CSS height={geo.get("logoCssH")}  filter={geo.get("logoFilter")}')
    for thr in (8, 20):
        bl, nl, ml = extent(dl, thr)
        bt, nt, mt = extent(dt, thr)
        if not bl or not bt:
            print(f'  thr>={thr}: logo={bl is not None} text={bt is not None} '
                  f'(一侧未检出)')
            continue
        lh = bl[3] - bl[1] + 1
        th = bt[3] - bt[1] + 1
        lc = (bl[1] + bl[3]) / 2
        tc = (bt[1] + bt[3]) / 2
        print(f'  thr>={thr:2d}: logo 墨迹 {lh:2d}px (y[{bl[1]}..{bl[3]}], {nl}px, '
              f'峰值差{ml}) | 标题墨迹 {th:2d}px (y[{bt[1]}..{bt[3]}], {nt}px, '
              f'峰值差{mt})')
        print(f'          差 = {lh - th:+d}px  ({lh / th * 100:.0f}%)   '
              f'中心线错位 = {lc - tc:+.1f}px')
        if thr == 8:
            res[tag] = dict(label=LABEL[tag], logo_ink=lh, text_ink=th,
                            diff=lh - th, ratio=round(lh / th * 100, 1),
                            offset=round(lc - tc, 1),
                            fontSize=geo.get('fontSize'),
                            logoCssH=geo.get('logoCssH'),
                            peak_logo=ml, peak_text=mt)
    # 行剖面
    bl, _, _ = extent(dl, 8)
    bt, _, _ = extent(dt, 8)
    if bl:
        print(f'  logo 行剖面: {[(y, sum(1 for x in range(bl[0], bl[2]+1) if dl[y][x] >= 8)) for y in range(bl[1], bl[3]+1)]}')
    if bt:
        print(f'  标题行剖面: {[(y, sum(1 for x in range(bt[0], bt[2]+1) if dt[y][x] >= 8)) for y in range(bt[1], bt[3]+1)]}')

print('\n' + '=' * 78)
print(json.dumps(res, ensure_ascii=False, indent=2))
json.dump(res, open(os.path.join(DIR, 'ratios.json'), 'w'), ensure_ascii=False, indent=2)
