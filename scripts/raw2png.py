import sys, os
from PIL import Image

raw_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/render.raw'
w = int(sys.argv[2]) if len(sys.argv) > 2 else 1240
h = int(sys.argv[3]) if len(sys.argv) > 3 else 840
out_path = sys.argv[4] if len(sys.argv) > 4 else raw_path.replace('.raw', '.png')
scale = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0

with open(raw_path, 'rb') as f:
    data = f.read()
img = Image.frombytes('RGB', (w, h), data)
if scale != 1.0:
    img = img.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
img.save(out_path)
print(f'saved {out_path} {img.size}')
