#!/usr/bin/env python3
"""split-logo-wheel.py — 把 logo-mark-nobg.png 拆成「六边形框」+「内部轮毂」两个透明 PNG。

加载动画要求：
  · 六边形外框完全静止
  · 只有六边形里面的轮毂样式图标旋转
  · 品牌字标（INSPIRE CAR / 灵感改装）保持静止

因此把 logo-mark-nobg.png 按中心圆拆成：
  1. logo-hex-nobg.png   — 只保留外部六边形框，中间圆形区域挖空（透明）
  2. logo-wheel-nobg.png — 只保留中心圆形区域内的轮毂，外部透明

两个文件保持与原图相同的画布尺寸（353×324），CSS 里直接叠放即可对齐，
无需计算相对位置。

用法：
    python3 scripts/split-logo-wheel.py
"""

from __future__ import annotations

import math
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "src", "assets")
SRC = os.path.join(ASSETS, "logo-mark-nobg.png")

# 中心圆的半径（px）。logo-mark-nobg.png 画布 353×324，轮毂外沿约在半径 122~128 之间，
# 六边形内沿约在 132~138 之间。取 R=128 既能完整包住轮毂，又不会切到六边形框。
WHEEL_RADIUS = 128


def read_png(path: str):
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"不是合法的 PNG：{path}")

    pos = 8
    idat = bytearray()
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
        elif ctype == b"IEND":
            break

    if bitdepth != 8 or colortype != 6:
        raise ValueError("仅支持 8bit RGBA PNG")
    if interlace != 0:
        raise ValueError("不支持隔行 PNG")

    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    out = bytearray(height * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ftype == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                b = prev[i]
                c = prev[i - 4] if i >= 4 else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                if pa <= pb and pa <= pc:
                    pred = a
                elif pb <= pc:
                    pred = b
                else:
                    pred = c
                line[i] = (line[i] + pred) & 0xFF
        elif ftype != 0:
            raise ValueError(f"未知 filter 类型：{ftype}")
        out[y * stride:(y + 1) * stride] = line
        prev = line

    return width, height, bytes(out)


def write_png(path: str, width: int, height: int, rgba: bytearray) -> None:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    blob = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(blob)


def _chunk(ctype: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + ctype
        + payload
        + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)
    )


def split(src_path: str, r: int, out_hex: str, out_wheel: str):
    width, height, buf = read_png(src_path)
    cx, cy = width / 2, height / 2
    r2 = r * r

    hex_rgba = bytearray(width * height * 4)
    wheel_rgba = bytearray(width * height * 4)

    for y in range(height):
        for x in range(width):
            dx = x - cx
            dy = y - cy
            inside = (dx * dx + dy * dy) <= r2
            i = (y * width + x) * 4
            a = buf[i + 3]
            # 原图已是黑线+透明底；直接复用 RGBA
            if inside:
                # 轮毂层保留中心圆内像素
                wheel_rgba[i:i + 4] = buf[i:i + 4]
                # 六边形层中心圆内挖空
                hex_rgba[i:i + 4] = b"\x00\x00\x00\x00"
            else:
                wheel_rgba[i:i + 4] = b"\x00\x00\x00\x00"
                hex_rgba[i:i + 4] = buf[i:i + 4]

    write_png(out_hex, width, height, hex_rgba)
    write_png(out_wheel, width, height, wheel_rgba)
    print(f"已生成 {out_hex}  {width}x{height}")
    print(f"已生成 {out_wheel}  {width}x{height}")


def main() -> int:
    print(f"源图：{SRC}  半径 R={WHEEL_RADIUS}px")
    split(
        SRC,
        WHEEL_RADIUS,
        os.path.join(ASSETS, "logo-hex-nobg.png"),
        os.path.join(ASSETS, "logo-wheel-nobg.png"),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
