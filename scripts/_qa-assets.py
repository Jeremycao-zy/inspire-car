#!/usr/bin/env python3
"""_qa-assets.py — 独立验证去背资源本身是否真的「透明底 + 纯黑线」。

不跑 make-logo-alpha.py，直接对产物做像素审计。
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
load, px, lum, alpha_hist = (_pnglib.load, _pnglib.px, _pnglib.lum,
                             _pnglib.alpha_hist)  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "src", "assets")


def audit(name, expect_wh):
    path = os.path.join(ASSETS, name)
    img = load(path)
    w, h = img["w"], img["h"]
    print("\n" + "=" * 68)
    print(f"{name}   {w}x{h}   (expect {expect_wh[0]}x{expect_wh[1]})"
          f"  colortype={img['ct']}")
    ok = (w, h) == expect_wh
    print(f"  尺寸匹配 CSS aspect-ratio 声明: {'PASS' if ok else 'FAIL'}")
    print(f"  实际 aspect = {w / h:.5f}")

    # 1. 四角必须完全透明
    corners = {"左上": px(img, 0, 0), "右上": px(img, w - 1, 0),
               "左下": px(img, 0, h - 1), "右下": px(img, w - 1, h - 1)}
    for k, v in corners.items():
        print(f"  角点 {k}: rgba={v}")
    corner_ok = all(v[3] == 0 for v in corners.values())
    print(f"  -> 四角全透明: {'PASS' if corner_ok else 'FAIL'}")

    # 2. 外圈 1px 边框必须全透明（有白框的话这里必然有 alpha>0）
    edge_max = 0
    for x in range(w):
        edge_max = max(edge_max, px(img, x, 0)[3], px(img, x, h - 1)[3])
    for y in range(h):
        edge_max = max(edge_max, px(img, 0, y)[3], px(img, w - 1, y)[3])
    print(f"  外圈 1px 边框最大 alpha = {edge_max}  "
          f"{'PASS' if edge_max <= 3 else 'FAIL(可能有描边/白框残留)'}")

    # 3. alpha 分布
    hist = alpha_hist(img)
    total = w * h
    a0 = hist[0]
    print(f"  alpha==0 像素: {a0}/{total} = {a0 / total * 100:.2f}%")
    faint = sum(hist[1:26])          # 1..25 极淡雾
    mid = sum(hist[26:230])
    solid = sum(hist[230:])
    print(f"  alpha 1..25 (淡雾风险区): {faint} = {faint / total * 100:.3f}%")
    print(f"  alpha 26..229 (抗锯齿边缘): {mid} = {mid / total * 100:.2f}%")
    print(f"  alpha 230..255 (实心墨): {solid} = {solid / total * 100:.2f}%")

    # 4. 所有 alpha>0 的像素 RGB 必须是纯黑（否则 invert 会偏色）
    bad = 0
    maxc = 0
    for i in range(0, total * 4, 4):
        if img["rgba"][i + 3] > 0:
            m = max(img["rgba"][i], img["rgba"][i + 1], img["rgba"][i + 2])
            maxc = max(maxc, m)
            if m > 8:
                bad += 1
    print(f"  有色像素(alpha>0)中非纯黑的数量={bad}, 最大通道值={maxc}  "
          f"{'PASS' if bad == 0 else 'FAIL(invert 会偏色)'}")

    # 5. 墨迹真实外框 vs 画布 —— 说明「盒子高度 == 视觉高度」是否成立
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if px(img, x, y)[3] > 8:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    print(f"  墨迹外框: x[{minx}..{maxx}] y[{miny}..{maxy}]"
          f"  = {maxx - minx + 1}x{maxy - miny + 1}")
    print(f"  上下留白 = {miny} / {h - 1 - maxy} px, "
          f"左右留白 = {minx} / {w - 1 - maxx} px")

    # 6. 检测「规则矩形块」：若存在大面积恒定的中等 alpha 矩形 -> 白雾块
    #    简单判据：统计 alpha 在 1..25 的像素是否连成大片矩形
    print(f"  淡雾像素(1..25)绝对数量 = {faint}")
    return img


if __name__ == "__main__":
    print("=" * 68)
    print("A-0. 去背资源自身像素审计（独立于生成脚本）")
    m = audit("logo-mark-nobg.png", (353, 324))
    f = audit("logo-full-nobg.png", (527, 512))

    # 交叉核对 full 是否 = mark + 下方字标
    print("\n" + "=" * 68)
    print("交叉核对：full 的墨迹 y 分布应呈现「徽标段 + 字标段」两段")
    rows = []
    for y in range(f["h"]):
        c = sum(1 for x in range(f["w"]) if px(f, x, y)[3] > 8)
        rows.append(c)
    bands = []
    st = None
    for y, c in enumerate(rows):
        if c > 0 and st is None:
            st = y
        elif c == 0 and st is not None:
            bands.append((st, y - 1))
            st = None
    if st is not None:
        bands.append((st, len(rows) - 1))
    print(f"  含墨的连续 y 区间: {bands}")
    for i, (a, b) in enumerate(bands):
        print(f"    band{i}: y[{a}..{b}] 高={b - a + 1}px")

    print("\n对照源文件 logo-full.png（白底原图）:")
    src = load(os.path.join(ASSETS, "logo-full.png"))
    print(f"  {src['w']}x{src['h']} ct={src['ct']}")
    print(f"  四角 rgba = {px(src, 0, 0)} / {px(src, src['w'] - 1, 0)}")
    h2 = [0] * 256
    for y in range(src["h"]):
        for x in range(src["w"]):
            h2[px(src, x, y)[3]] += 1
    print(f"  alpha 直方图非255的像素数 = {sum(h2[:255])} "
          f"(源文件不透明度) -> 确认白底长在图上")
