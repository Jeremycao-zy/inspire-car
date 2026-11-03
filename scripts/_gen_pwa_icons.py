"""临时脚本：用 Pillow 把霓虹标志压到纯黑方图上，生成 PWA 图标。
不属于运行时代码，仅用于本地生成 public/icons/* 。"""
from PIL import Image
import os

SRC = "src/assets/logo-mark-neon.png"
OUT = "public/icons"

os.makedirs(OUT, exist_ok=True)
mark = Image.open(SRC).convert("RGBA")
mw, mh = mark.size


def compose(size, margin):
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    box = size * (1 - margin)
    scale = box / max(mw, mh)
    nw, nh = max(1, round(mw * scale)), max(1, round(mh * scale))
    resized = mark.resize((nw, nh), Image.LANCZOS)
    x = (size - nw) // 2
    y = (size - nh) // 2
    canvas.alpha_composite(resized, (x, y))
    return canvas


compose(192, 0.12).save(f"{OUT}/icon-192.png", "PNG")
compose(512, 0.12).save(f"{OUT}/icon-512.png", "PNG")
compose(512, 0.40).save(f"{OUT}/maskable-512.png", "PNG")  # maskable 安全区
compose(180, 0.0).save(f"{OUT}/apple-touch-icon.png", "PNG")  # iOS 不接受透明
print("PWA 图标已生成:", os.listdir(OUT))
