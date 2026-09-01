#!/usr/bin/env python3
"""_qa-analyze.py — 对 _qa-suite.mjs 产出的截图做像素级判定。

三件事：
  A. 白框是否真的消失（四角采样 + 纯白矩形块检测）
  B. logo 墨迹高度 vs 中文标题墨迹高度（核心尺寸对齐判定）
  C. 小尺寸下 logo 是否还「看得清」（有效墨量 / 对比度）
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
load, px, lum = PL.load, PL.px, PL.lum

DIR = '/tmp/_qa'
META = json.load(open(os.path.join(DIR, 'meta.json')))


def L(p):
    return (p[0] * 299 + p[1] * 587 + p[2] * 114) // 1000


def region_bg(img, box, inset=0):
    """box 内出现频次最高的颜色作为背景。"""
    x0, y0, w, h = box
    cnt = {}
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            p = px(img, x, y)
            if p is None:
                continue
            cnt[(p[0], p[1], p[2])] = cnt.get((p[0], p[1], p[2]), 0) + 1
    return max(cnt.items(), key=lambda kv: kv[1])[0]


def scan_ink_rows(img, box, bg, thr):
    """在 box 内逐行统计「比 bg 暗 >= thr」的像素数，返回 (rows, first, last)。"""
    x0, y0, w, h = box
    bgl = L(bg)
    rows = []
    for y in range(y0, y0 + h):
        c = 0
        for x in range(x0, x0 + w):
            p = px(img, x, y)
            if p is None:
                continue
            if bgl - L(p) >= thr:
                c += 1
        rows.append((y, c))
    nz = [(y, c) for y, c in rows if c > 0]
    if not nz:
        return rows, None, None
    return rows, nz[0][0], nz[-1][0]


def scan_ink_cols(img, box, bg, thr):
    x0, y0, w, h = box
    bgl = L(bg)
    cols = []
    for x in range(x0, x0 + w):
        c = 0
        for y in range(y0, y0 + h):
            p = px(img, x, y)
            if p is None:
                continue
            if bgl - L(p) >= thr:
                c += 1
        cols.append((x, c))
    nz = [(x, c) for x, c in cols if c > 0]
    if not nz:
        return cols, None, None
    return cols, nz[0][0], nz[-1][0]


def clip_to(img, clip, rect):
    """把视口坐标 rect 换算成截图内的局部坐标 box=(x0,y0,w,h)。"""
    x0 = int(round(rect['x'] - clip['x']))
    y0 = int(round(rect['y'] - clip['y']))
    return (max(0, x0), max(0, y0),
            max(1, int(round(rect['w']))), max(1, int(round(rect['h']))))


print('=' * 76)
print('QA 像素分析  —  logo 去白框 / 尺寸对齐')
print('=' * 76)

report = {}

# ============================================================ B. 车库 header
print('\n' + '#' * 76)
print('# B. 尺寸对齐：logo 墨迹高度 vs 中文标题「灵感改装」墨迹高度')
print('#' * 76)

for tag in ('1280', '861', '860', '800'):
    sc = META['scenarios'].get('garage' + tag)
    if not sc or 'geo' not in sc or 'err' in sc:
        print(f'\n[{tag}] 跳过: {sc.get("err") if sc else "no data"}')
        continue
    geo = sc['geo']
    clip = sc['clip']
    png = os.path.join(DIR, f'garage-{tag}.png')
    img = load(png)
    print(f'\n--- 视口宽 {tag}px  截图 {img["w"]}x{img["h"]}  clip={clip} ---')

    lr = geo['logo']['rect']
    tr = geo['text']['range']
    # logo 的取样框：用 DOM rect，向外扩 2px 保证完整捕获
    lbox = (int(round(lr['x'] - clip['x'])) - 2, int(round(lr['y'] - clip['y'])) - 2,
            int(round(lr['w'])) + 4, int(round(lr['h'])) + 4)
    # 文字取样框：Range 的 x 区间（紧凑到文字左右），y 用 Range 区间外扩
    tbox = (int(round(tr['x'] - clip['x'])), int(round(tr['y'] - clip['y'])),
            int(round(tr['w'])), int(round(tr['h'])))

    # 背景：取 logo 框左侧 6px 的净背景条
    bgbox = (max(0, lbox[0] - 8), lbox[1], 6, lbox[3])
    bg = region_bg(img, bgbox)
    print(f'  背景色(logo 左侧净区) = rgb{bg}  亮度={L(bg)}')

    THR = 30
    rows_l, lt, lb = scan_ink_rows(img, lbox, bg, THR)
    rows_t, tt, tb = scan_ink_rows(img, tbox, bg, THR)

    logo_ink = (lb - lt + 1) if lt is not None else 0
    text_ink = (tb - tt + 1) if tt is not None else 0

    print(f'  [logo]  DOM rect h={lr["h"]:.2f}px  墨迹 y[{lt}..{lb}] '
          f'-> 视觉高 {logo_ink}px')
    print(f'  [文字]  font-size={geo["text"]["css"]["fontSize"]}  '
          f'Range y[{tr["y"]:.2f}..{tr["y"]+tr["h"]:.2f}]  '
          f'墨迹 y[{tt}..{tb}] -> 视觉高 {text_ink}px')
    diff = logo_ink - text_ink
    print(f'  >>> 差值 logo - 文字 = {diff:+d}px  '
          f'(logo 占文字 {logo_ink / text_ink * 100:.1f}%)')

    # 中心线对比
    lc = (lt + lb) / 2
    tc = (tt + tb) / 2
    print(f'  中心线: logo y={lc:.1f}  文字 y={tc:.1f}  '
          f'垂直错位 = {lc - tc:+.1f}px (正=logo 偏下)')

    # 逐行墨量剖面（前 3 / 后 3 行，看边缘是否渐进）
    nz = [(y, c) for y, c in rows_l if c > 0]
    print(f'  logo 行剖面(前3): {nz[:3]}   (后3): {nz[-3:]}')
    nzt = [(y, c) for y, c in rows_t if c > 0]
    print(f'  文字行剖面(前3): {nzt[:3]}   (后3): {nzt[-3:]}')

    report['garage' + tag] = dict(
        logo_ink=logo_ink, text_ink=text_ink, diff=diff,
        logo_y=(lt, lb), text_y=(tt, tb), center_offset=lc - tc,
        bg=bg, fontSize=geo['text']['css']['fontSize'],
        logoCssH=geo['logo']['css']['h'], logoRectH=lr['h'])

# ============================================================ A. 白框
print('\n' + '#' * 76)
print('# A. 白框是否消失：logo 包围盒四角 vs 紧邻背景')
print('#' * 76)

def corner_check(name, png, clip, rect, pad_out=6, expect_dark=False):
    img = load(png)
    lr = rect
    x0 = int(round(lr['x'] - clip['x']))
    y0 = int(round(lr['y'] - clip['y']))
    w = int(round(lr['w']))
    h = int(round(lr['h']))
    # 紧邻背景样本：logo 框外 pad_out px 处
    bg_samples = []
    for dx in (-pad_out, w + pad_out - 1):
        for dy in (h // 2,):
            p = px(img, x0 + dx, y0 + dy)
            if p: bg_samples.append(p)
    for dy in (-pad_out, h + pad_out - 1):
        for dx in (w // 2,):
            p = px(img, x0 + dx, y0 + dy)
            if p: bg_samples.append(p)
    bgc = tuple(sum(p[i] for p in bg_samples) // len(bg_samples) for i in range(3))
    bgl = L(bgc)

    corners = {
        '左上': px(img, x0, y0),
        '右上': px(img, x0 + w - 1, y0),
        '左下': px(img, x0, y0 + h - 1),
        '右下': px(img, x0 + w - 1, y0 + h - 1),
    }
    print(f'\n  [{name}] {os.path.basename(png)}  logo box {w}x{h} '
          f'@({x0},{y0})')
    print(f'    紧邻背景 rgb{bgc} 亮度={bgl}')
    worst = 0
    for k, v in corners.items():
        d = L(v) - bgl
        worst = max(worst, abs(d))
        print(f'    角点 {k}: rgb{v} 亮度={L(v)}  与背景差={d:+d}')
    # 框内纯白像素占比（有白框时应是接近 100% 的规则矩形）
    white = tot = 0
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            p = px(img, x, y)
            if p is None: continue
            tot += 1
            if p[0] >= 250 and p[1] >= 250 and p[2] >= 250:
                white += 1
    print(f'    框内纯白(>=250)像素 = {white}/{tot} = {white / tot * 100:.1f}%')
    verdict = 'PASS 无白框' if worst <= 8 else 'FAIL 疑似白框'
    print(f'    判定: {verdict} (四角与背景最大亮度差 {worst})')
    return dict(bg=bgc, corners=corners, worst=worst, whitePct=white / tot * 100)


for tag in ('1280', '800'):
    sc = META['scenarios'].get('garage' + tag)
    if sc and 'geo' in sc:
        corner_check(f'车库 header @{tag}',
                     os.path.join(DIR, f'garage-{tag}-wide.png'),
                     sc['wideClip'], sc['geo']['logo']['rect'])

# 登录卡（浅底）
sc = META['scenarios'].get('authCard')
if sc and 'geo' in sc:
    corner_check('登录卡 logo', os.path.join(DIR, 'auth-card.png'),
                 sc['clip'], sc['geo']['logo']['rect'])

# 顶栏（深色 + invert）
sc = META['scenarios'].get('appbar')
if sc and 'geo' in sc:
    corner_check('顶栏 appbar logo', os.path.join(DIR, 'appbar.png'),
                 sc['clip'], sc['geo']['logo']['rect'])

# 水印（深色 3D 上）
sc = META['scenarios'].get('watermark')
if sc and 'geo' in sc and os.path.exists(os.path.join(DIR, 'watermark.png')):
    corner_check('3D 水印 logo', os.path.join(DIR, 'watermark.png'),
                 sc['clip'], sc['geo']['logo']['rect'])

# 加载遮罩（深色）
for nm, key in (('加载遮罩 @1280', 'overlay1280'), ('加载遮罩 @700', 'overlay700')):
    sc = META['scenarios'].get(key)
    if sc and 'geo' in sc:
        corner_check(nm, os.path.join(DIR, key.replace('overlay', 'overlay-') + '.png'),
                     sc['clip'], sc['geo']['logo']['rect'])

# ============================================================ C. 清晰度
print('\n' + '#' * 76)
print('# C. 小尺寸清晰度：有效墨量与对比度')
print('#' * 76)

def clarity(name, png, clip, rect):
    img = load(png)
    lr = rect
    x0 = int(round(lr['x'] - clip['x']))
    y0 = int(round(lr['y'] - clip['y']))
    w = int(round(lr['w'])); h = int(round(lr['h']))
    box = (x0, y0, w, h)
    bg = region_bg(img, (max(0, x0 - 8), y0, 6, h)) if x0 >= 8 else region_bg(img, box)
    bgl = L(bg)
    strong = mid = faint = 0
    tot = w * h
    mn = 255
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            p = px(img, x, y)
            if p is None: continue
            d = abs(L(p) - bgl)
            mn = min(mn, L(p))
            if d >= 90: strong += 1
            elif d >= 35: mid += 1
            elif d >= 12: faint += 1
    print(f'\n  [{name}] 渲染 {w}x{h}px  背景亮度={bgl}  最暗={mn}')
    print(f'    强墨(d>=90): {strong:4d} ({strong / tot * 100:5.1f}%)  '
          f'中(d>=35): {mid:4d} ({mid / tot * 100:5.1f}%)  '
          f'弱(d>=12): {faint:4d} ({faint / tot * 100:5.1f}%)')
    print(f'    有效像素(>=35) 合计 = {strong + mid} '
          f'({(strong + mid) / tot * 100:.1f}%)')
    print(f'    最大对比度 = {abs(mn - bgl)}/255')
    return dict(w=w, h=h, strong=strong, mid=mid, faint=faint, minL=mn, bgl=bgl)


for nm, key, png in (
    ('水印 15px', 'watermark', 'watermark.png'),
    ('顶栏 18px', 'appbar', 'appbar.png'),
    ('登录卡 20px', 'authCard', 'auth-card.png'),
):
    sc = META['scenarios'].get(key)
    if sc and 'geo' in sc and os.path.exists(os.path.join(DIR, png)):
        clarity(nm, os.path.join(DIR, png), sc['clip'], sc['geo']['logo']['rect'])

for tag in ('1280', '800'):
    sc = META['scenarios'].get('garage' + tag)
    if sc and 'geo' in sc:
        clarity(f'车库 header logo @{tag}',
                os.path.join(DIR, f'garage-{tag}-wide.png'),
                sc['wideClip'], sc['geo']['logo']['rect'])

print('\n' + '=' * 76)
json.dump(report, open(os.path.join(DIR, 'analysis.json'), 'w'),
          ensure_ascii=False, indent=2)
print('analysis.json 已写出')
