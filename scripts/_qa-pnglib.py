#!/usr/bin/env python3
"""_qa-pnglib.py — QA 独立写的纯标准库 PNG 读写/像素分析库。

与 scripts/make-logo-alpha.py 里的解码器互相独立（自己重新实现一遍），
避免「用被测代码验证被测代码」的循环论证。

仅依赖 zlib / struct，无需 Pillow。
"""
from __future__ import annotations

import os
import struct
import zlib


# ------------------------------------------------------------------ 解码

def load(path):
    """解码 8bit 非隔行 PNG -> dict(w,h,ch,ct,rgba,plte)。rgba 为 bytearray。"""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a png: %s" % path)

    pos = 8
    idat = bytearray()
    plte = None
    width = height = bitdepth = ct = interlace = None

    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bitdepth, ct, _c, _f, interlace = struct.unpack(
                ">IIBBBBB", chunk)
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"PLTE":
            plte = chunk
        elif ctype == b"IEND":
            break

    if bitdepth != 8:
        raise ValueError("bitdepth %s unsupported" % bitdepth)
    if interlace:
        raise ValueError("interlaced png unsupported")

    raw = zlib.decompress(bytes(idat))
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    stride = width * ch
    out = bytearray(height * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if ft == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                if pa <= pb and pa <= pc:
                    pred = a
                elif pb <= pc:
                    pred = b
                else:
                    pred = c
                line[i] = (line[i] + pred) & 0xFF
        elif ft != 0:
            raise ValueError("bad filter %s" % ft)
        out[y * stride:(y + 1) * stride] = line
        prev = line

    # 统一成 RGBA
    rgba = bytearray(width * height * 4)
    for i in range(width * height):
        s = i * ch
        if ct == 6:
            r, g, b, a = out[s], out[s + 1], out[s + 2], out[s + 3]
        elif ct == 2:
            r, g, b, a = out[s], out[s + 1], out[s + 2], 255
        elif ct == 0:
            r = g = b = out[s]; a = 255
        elif ct == 4:
            r = g = b = out[s]; a = out[s + 1]
        elif ct == 3:
            idx = out[s]
            r, g, b = plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2]
            a = 255
        else:
            raise ValueError("colortype %s" % ct)
        d = i * 4
        rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = a

    return dict(w=width, h=height, ch=ch, ct=ct, rgba=rgba)


def px(img, x, y):
    """返回 (r,g,b,a)；越界返回 None。"""
    w, h = img["w"], img["h"]
    if x < 0 or y < 0 or x >= w or y >= h:
        return None
    i = (y * w + x) * 4
    return img["rgba"][i], img["rgba"][i + 1], img["rgba"][i + 2], img["rgba"][i + 3]


def lum(p):
    return (p[0] * 299 + p[1] * 587 + p[2] * 114) // 1000


def save_png(path, w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)

    def ck(t, d):
        return (struct.pack(">I", len(d)) + t + d
                + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF))
    blob = (b"\x89PNG\r\n\x1a\n" + ck(b"IHDR", ihdr)
            + ck(b"IDAT", zlib.compress(bytes(raw), 9)) + ck(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(blob)


def crop(img, x0, y0, w, h):
    out = bytearray(w * h * 4)
    for y in range(h):
        sy = y0 + y
        src = (sy * img["w"] + x0) * 4
        out[y * w * 4:(y + 1) * w * 4] = img["rgba"][src:src + w * 4]
    return dict(w=w, h=h, ct=6, rgba=out)


# ------------------------------------------------------------------ 分析

def alpha_hist(img, box=None):
    """alpha 直方图统计。box=(x0,y0,w,h)。"""
    x0, y0, w, h = box or (0, 0, img["w"], img["h"])
    hist = [0] * 256
    for y in range(y0, y0 + h):
        base = (y * img["w"] + x0) * 4
        for x in range(w):
            hist[img["rgba"][base + x * 4 + 3]] += 1
    return hist


def ink_rows(img, box, thr):
    """在 box 内，逐行统计「比背景暗 thr 以上」的像素数 -> [(y,count)]。

    用于测文字/图形的墨迹上下边界。
    """
    x0, y0, w, h = box
    # 背景基准：取 box 内每列的最亮值的中位数
    bg = background_color(img, box)
    bgl = lum(bg)
    rows = []
    for y in range(y0, y0 + h):
        c = 0
        base = (y * img["w"] + x0) * 4
        for x in range(w):
            p = (img["rgba"][base + x * 4], img["rgba"][base + x * 4 + 1],
                 img["rgba"][base + x * 4 + 2], img["rgba"][base + x * 4 + 3])
            if bgl - lum(p) >= thr:
                c += 1
        rows.append((y, c))
    return rows


def background_color(img, box, sample=2000):
    """用出现频次最高的像素作为背景色（抗噪）。"""
    x0, y0, w, h = box
    counts = {}
    step = max(1, (w * h) // sample)
    for y in range(y0, y0 + h):
        base = (y * img["w"] + x0) * 4
        for x in range(0, w, step):
            i = base + x * 4
            k = (img["rgba"][i], img["rgba"][i + 1], img["rgba"][i + 2])
            counts[k] = counts.get(k, 0) + 1
    return max(counts.items(), key=lambda kv: kv[1])[0]


def bbox_of_dark(img, box, thr, min_px=1):
    """box 内找出「比背景暗 >= thr」的像素包围盒，返回 (x0,y0,x1,y1) 或 None。

    注意：这里不用绝对阈值，而是相对 box 内众数背景色，这样对深色/浅色背景
    都成立。
    """
    x0, y0, w, h = box
    bg = background_color(img, box)
    bgl = lum(bg)
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(y0, y0 + h):
        base = (y * img["w"] + x0) * 4
        for x in range(w):
            i = base + x * 4
            l = (img["rgba"][i] * 299 + img["rgba"][i + 1] * 587
                 + img["rgba"][i + 2] * 114) // 1000
            if bgl - l >= thr:
                if x + x0 < minx: minx = x + x0
                if x + x0 > maxx: maxx = x + x0
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        return None
    return (minx, miny, maxx, maxy)
