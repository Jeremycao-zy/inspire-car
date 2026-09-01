#!/usr/bin/env python3
"""_qa-finalanalyze.py — 复测各尺寸 logo 的清晰度（height 已改 21/16）。"""
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

DIR = '/tmp/_qa/final'
META = json.load(open(os.path.join(DIR, 'meta.json')))

GROUPS = [
    ('auth20',   'auth20',   '登录卡 20px (浅底·不反相)'),
    ('garage21', 'garage21', '车库 header 21px (浅底·不反相)  ← 本次调整'),
    ('appbar18', 'appbar18', '顶栏 18px (深色·invert)'),
    ('wm15',     'wm15',     '3D 水印 15px (深色·invert·opacity.35)'),
]

print('=' * 78)
print('C 复测：各尺寸 logo 清晰度（差分隔离）')
print('=' * 78)

for gname, key, label in GROUPS:
    pa, pb = os.path.join(DIR, f'{gname}-A.png'), os.path.join(DIR, f'{gname}-B.png')
    if not (os.path.exists(pa) and os.path.exists(pb)):
        print(f'\n[{label}] 缺文件'); continue
    A = load(pa); B = load(pb)
    w, h = A['w'], A['h']
    d = [[0] * w for _ in range(h)]
    mx = 0
    for y in range(h):
        for x in range(w):
            a = px(A, x, y); b = px(B, x, y)
            v = max(abs(a[0]-b[0]), abs(a[1]-b[1]), abs(a[2]-b[2]))
            d[y][x] = v
            if v > mx: mx = v
    info = META.get(key, {}).get('info', {})
    minx, miny, maxx, maxy = w, h, -1, -1
    cnt = {'>=8': 0, '>=20': 0, '>=40': 0, '>=80': 0, '>=140': 0}
    for y in range(h):
        for x in range(w):
            v = d[y][x]
            for t in (8, 20, 40, 80, 140):
                if v >= t: cnt[f'>={t}'] += 1
            if v >= 8:
                minx = min(minx, x); maxx = max(maxx, x)
                miny = min(miny, y); maxy = max(maxy, y)
    print(f'\n--- {label} ---')
    print(f'  cssH={info.get("cssH")} cssW={info.get("cssW")} '
          f'rect={info.get("w",0):.1f}x{info.get("h",0):.1f} filter={info.get("filter")}')
    if maxx >= 0:
        print(f'  足迹 {maxx-minx+1}x{maxy-miny+1}px   最大对比度 {mx}/255 '
              f'({mx/255*100:.0f}%)')
    else:
        print(f'  足迹 = 空（不可见）  最大对比度 {mx}')
    print('  分级: ' + '  '.join(f'{k}:{v}' for k, v in cnt.items()))
    if maxx >= 0:
        rows = [(y, sum(1 for x in range(minx, maxx+1) if d[y][x] >= 20))
                for y in range(miny, maxy+1)]
        print(f'  行剖面(>=20): {rows}')
        solid = sum(1 for _, c in rows if c >= 3)
        print(f'  有结构的行数(>=3 实心像素) = {solid}/{len(rows)}')
        verdict = []
        if mx >= 100: verdict.append('对比充足')
        elif mx >= 60: verdict.append('对比中等')
        else: verdict.append('对比偏低')
        verdict.append('有结构' if solid >= len(rows) * 0.5 else '结构弱')
        print(f'  判定: ' + ' / '.join(verdict))

print('\n' + '=' * 78)
print('D. 3D 回归:')
st = META.get('tabs', [])
for t in st:
    print(f'  Tab {t.get("tab")}: ok={t.get("ok")} 可见区块={t.get("visibleBlocks")} '
          f'canvas={t.get("canvas")}')
rp = META.get('rimPresets', [])
bad = [p for p in rp if not p.get('clicked', {}).get('ok')
       or p.get('wheels', {}).get('count') != 4 or p.get('newErrors', 0) > 0]
print(f'  轮毂预设 {len(rp)} 个: 全部切换成功={len(bad) == 0}   '
      f'异常={[p["preset"]["id"] for p in bad]}')
for p in rp:
    print(f'    {p["preset"]["id"]:9s} -> 轮数 {p["wheels"].get("count")} '
          f'新增报错 {p["newErrors"]}')
print(f'  consoleErrors = {META.get("logs", {}).get("error")}')
print(f'  exceptions    = {META.get("logs", {}).get("exception")}')
print(f'  pageerrors    = {META.get("logs", {}).get("pageerror")}')
wg = META.get('wheelGeom', {})
print('  轮位几何:')
for c in wg.get('corners', []):
    print(f'    {c["id"]}: center={c["center"]} size={c["size"]}')
