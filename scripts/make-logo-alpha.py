#!/usr/bin/env python3
"""make-logo-alpha.py — 由白底不透明的源 logo 生成「去背」PNG 资源。

背景
----
src/assets/ 下的品牌图（logo-icon.png / logo-full.png）是用户上传的
**黑线 + 白底 + 不透明** PNG（四角像素为 (255,255,255,255)，alpha 恒为 255）。
因此仅删掉 CSS 里的 `background: #fff` 并不能去掉白色方框——白底来自图片本身。

做法
----
源图是「纯黑墨」合成在「纯白底」上的结果，且整幅图是纯灰度（实测所有非白
像素的 RGB 通道最大偏差 <= 9，只剩抗锯齿噪声）。于是可以按下面的关系精确反解：

    observed = 255 * (1 - a)          # 黑墨覆盖率 a 合成到白底上的观测灰度
    =>  a     = 1 - observed / 255
    =>  alpha = 255 - luminance

输出的 RGB 固定为纯黑 (0,0,0)，alpha 取 `255 - luminance`。这样：
  * 合成到任意浅色背景上，结果与原始白底图逐像素一致；
  * 因为是纯灰度，`filter: invert(1)` 后可无损变成白线图，用于深色背景。

输出
----
  * logo-mark-nobg.png — 只保留徽标图形（裁掉字标，并裁到图形外框）
  * logo-full-nobg.png — 完整锁定（徽标 + 字标），裁到整体外框

两个文件都裁掉了源图四周的透明留白，使元素盒子正好等于图形盒子，
这样 CSS 里就能直接用 `height: <px>; width: auto;` 精确控制视觉高度，
不会被 `object-fit: contain` 的留白悄悄压小。

用法
----
    python3 scripts/make-logo-alpha.py

仅依赖 Python 标准库（zlib / struct），无需 Pillow。
"""

from __future__ import annotations

import os
import struct
import sys
import zlib

# ---------------------------------------------------------------- 常量

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "src", "assets")
SRC = os.path.join(ASSETS, "logo-full.png")

# 低于该亮度视为「有墨」。245 能滤掉纯白底，同时保留抗锯齿的边缘像素。
INK_THRESHOLD = 245
# 裁切时在墨迹外框外额外保留的透明边距（px），避免裁掉抗锯齿的半透明边缘。
PAD = 2
# 噪声底：源图的白底并不是纯 255（有 JPEG 式噪点，实测大量像素落在 250~253），
# 直接取 alpha = 255 - L 会让整幅图蒙上一层 alpha 2~5 的「灰雾」。
# 这层灰雾在浅色背景上看不见，但深色背景下反相成白线后会变成一团极淡的白雾方块。
# 因此把 alpha <= NOISE_FLOOR 的部分压到 0，并把剩余区间线性拉伸回 0~255，
# 既彻底清掉噪点，又不会在阈值处产生硬边。
NOISE_FLOOR = 6

# logo-full.png 的两段墨迹（由行扫描得到）：
#   徽标  y[140..459] x[337..685]
#   字标  y[574..647] x[251..773]
# 这里显式声明，避免每次都全图扫描；若源图更换，改 SCRIPT 里 detect_bands() 调用即可。
MARK_BAND = (140, 459)  # 只含徽标的那一段 y 区间


# ---------------------------------------------------------------- PNG 解码

def read_png(path: str):
    """解码 8bit 非隔行的 PNG，返回 (w, h, channels, colortype, pixels, plte)。"""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"不是合法的 PNG：{path}")

    pos = 8
    idat = bytearray()
    plte = None
    width = height = bitdepth = colortype = interlace = None

    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bitdepth, colortype, _comp, _filt, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"PLTE":
            plte = chunk
        elif ctype == b"IEND":
            break

    if bitdepth != 8:
        raise ValueError(f"仅支持 8bit 位深，实际为 {bitdepth}")
    if interlace != 0:
        raise ValueError("不支持隔行（interlace）PNG")

    raw = zlib.decompress(bytes(idat))
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colortype]
    stride = width * channels

    out = bytearray(height * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ftype == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                if pa <= pb and pa <= pc:
                    pred = a
                elif pb <= pc:
                    pred = b
                else:
                    pred = c
                line[i] = (line[i] + pred) & 0xFF
        elif ftype != 0:
            raise ValueError(f"未知的 filter 类型：{ftype}")
        out[y * stride:(y + 1) * stride] = line
        prev = line

    return width, height, channels, colortype, bytes(out), plte


def get_px(buf: bytes, width: int, channels: int, colortype: int,
           plte: bytes | None, x: int, y: int) -> tuple[int, int, int, int]:
    """取 (r, g, b, a)。"""
    i = (y * width + x) * channels
    if colortype == 6:
        return buf[i], buf[i + 1], buf[i + 2], buf[i + 3]
    if colortype == 2:
        return buf[i], buf[i + 1], buf[i + 2], 255
    if colortype == 3:
        idx = buf[i]
        return plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2], 255
    raise ValueError(f"不支持的 color type：{colortype}")


def luminance(r: int, g: int, b: int) -> int:
    """感知亮度（整数近似，够用于阈值判断）。"""
    return (r * 299 + g * 587 + b * 114) // 1000


# ---------------------------------------------------------------- 工具

def detect_bands(width: int, height: int, buf: bytes, channels: int,
                 colortype: int, plte: bytes | None) -> list[tuple[int, int]]:
    """扫描出所有「含墨」的连续 y 区间（用于把徽标与字标分开）。"""
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for y in range(height):
        has_ink = False
        for x in range(width):
            r, g, b, _a = get_px(buf, width, channels, colortype, plte, x, y)
            if luminance(r, g, b) < INK_THRESHOLD:
                has_ink = True
                break
        if has_ink and start is None:
            start = y
        elif not has_ink and start is not None:
            bands.append((start, y - 1))
            start = None
    if start is not None:
        bands.append((start, height - 1))
    return bands


def ink_bbox(width: int, height: int, buf: bytes, channels: int,
             colortype: int, plte: bytes | None,
             y0: int, y1: int) -> tuple[int, int, int, int]:
    """在 y 区间 [y0, y1] 内求墨迹外框，返回 (x0, y0, x1, y1)（闭区间）。"""
    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y in range(max(0, y0), min(height, y1 + 1)):
        for x in range(width):
            r, g, b, _a = get_px(buf, width, channels, colortype, plte, x, y)
            if luminance(r, g, b) < INK_THRESHOLD:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if max_x < 0:
        raise ValueError(f"y 区间 [{y0}, {y1}] 内没有任何墨迹")
    return min_x, min_y, max_x, max_y


# ---------------------------------------------------------------- PNG 编码

def _chunk(ctype: bytes, payload: bytes) -> bytes:
    return (struct.pack(">I", len(payload)) + ctype + payload
            + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF))


def write_png(path: str, width: int, height: int, rgba: bytearray) -> None:
    """写 8bit RGBA PNG（filter 全 0，zlib 最高压缩）。"""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type: None
        raw += rgba[y * stride:(y + 1) * stride]

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    blob = (b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(blob)


# ---------------------------------------------------------------- 主流程

def build(out_name: str, box: tuple[int, int, int, int],
          width: int, height: int, buf: bytes, channels: int,
          colortype: int, plte: bytes | None) -> tuple[int, int]:
    """按 box=(x0,y0,x1,y1) 裁切并去背，写出 out_name，返回 (w, h)。"""
    x0, y0, x1, y1 = box
    # 外扩 PAD，并夹到图像范围内
    x0 = max(0, x0 - PAD)
    y0 = max(0, y0 - PAD)
    x1 = min(width - 1, x1 + PAD)
    y1 = min(height - 1, y1 + PAD)

    out_w, out_h = x1 - x0 + 1, y1 - y0 + 1
    out = bytearray(out_w * out_h * 4)

    for row in range(out_h):
        sy = y0 + row
        base = row * out_w * 4
        for col in range(out_w):
            sx = x0 + col
            r, g, b, _a = get_px(buf, width, channels, colortype, plte, sx, sy)
            # 反解墨迹覆盖率：alpha = 255 - 亮度
            alpha = 255 - luminance(r, g, b)
            # 扣掉噪声底并线性拉伸回 0~255：
            # 否则整幅图会蒙着一层 alpha 2~5 的灰雾，深色背景下反相后变成淡白雾方块。
            if alpha <= NOISE_FLOOR:
                alpha = 0
            else:
                alpha = (alpha - NOISE_FLOOR) * 255 // (255 - NOISE_FLOOR)
                if alpha > 255:
                    alpha = 255
            i = base + col * 4
            # 纯黑墨 + 反解出的覆盖率；纯灰度图保证反相后即为白线
            out[i] = 0
            out[i + 1] = 0
            out[i + 2] = 0
            out[i + 3] = alpha

    out_path = os.path.join(ASSETS, out_name)
    write_png(out_path, out_w, out_h, out)
    return out_w, out_h


def main() -> int:
    width, height, channels, colortype, buf, plte = read_png(SRC)
    print(f"源图：{os.path.relpath(SRC, ROOT)}  {width}x{height} "
          f"channels={channels} colortype={colortype}")

    bands = detect_bands(width, height, buf, channels, colortype, plte)
    print(f"墨迹 y 区间：{bands}")
    if not bands:
        print("错误：源图里没有找到任何墨迹", file=sys.stderr)
        return 1

    # 徽标：取 MARK_BAND 指定的那一段（只含图形，不含字标）
    mark_box = ink_bbox(width, height, buf, channels, colortype, plte, *MARK_BAND)
    # 完整锁定：跨全部墨迹区间
    full_box = ink_bbox(width, height, buf, channels, colortype, plte,
                        bands[0][0], bands[-1][1])

    mw, mh = build("logo-mark-nobg.png", mark_box,
                   width, height, buf, channels, colortype, plte)
    fw, fh = build("logo-full-nobg.png", full_box,
                   width, height, buf, channels, colortype, plte)

    print(f"已生成 logo-mark-nobg.png  {mw}x{mh}  (aspect {mw / mh:.4f})")
    print(f"已生成 logo-full-nobg.png  {fw}x{fh}  (aspect {fw / fh:.4f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
