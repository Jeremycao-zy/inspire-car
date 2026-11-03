#!/usr/bin/env python3
"""把 GLB 内嵌的 PNG 贴图转成更小体积的 JPEG（去掉 alpha、最长边缩放），其余几何/数据原样保留。

用法:
  python scripts/compress-glb-textures.py <in.glb> <out.glb> [--max 2048] [--q 82]

只改写被 images[].bufferView 引用的那几个 bufferView 的字节内容 + byteLength + mimeType，
不改动几何 bufferView 的偏移/步长，因此可与 Draco 几何压缩叠加使用。
"""
import sys, json, struct
from pathlib import Path
from PIL import Image
from io import BytesIO

MAX_SIDE = 2048
QUALITY = 82

def align4(n):
    return (n + 3) & ~3

def read_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:4] == b'glTF', 'not a GLB'
    ver, total = struct.unpack('<II', data[8:16])
    pos = 12
    json_bytes = None
    bin_bytes = None
    while pos < len(data):
        clen, ctype = struct.unpack('<II', data[pos:pos+8])
        body = data[pos+8:pos+8+clen]
        if ctype == 0x4E4F534A:
            json_bytes = body
        elif ctype == 0x004E4942:
            bin_bytes = body
        pos += 8 + clen
    return json.loads(json_bytes), bin_bytes

def write_glb(doc, bin_bytes, path):
    json_bytes = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    # JSON chunk pad with spaces
    while len(json_bytes) % 4 != 0:
        json_bytes += b' '
    while len(bin_bytes) % 4 != 0:
        bin_bytes += b'\x00'
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack('<II', len(bin_bytes), 0x004E4942))
        f.write(bin_bytes)

def main():
    if len(sys.argv) < 3:
        print('usage: compress-glb-textures.py <in.glb> <out.glb> [--max 2048] [--q 82]')
        sys.exit(1)
    inp, outp = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]
    i = 0
    while i < len(args):
        if args[i] == '--max':
            global MAX_SIDE; MAX_SIDE = int(args[i+1]); i += 2
        elif args[i] == '--q':
            global QUALITY; QUALITY = int(args[i+1]); i += 2
        else:
            i += 1

    doc, bin_bytes = read_glb(inp)
    bvs = doc.get('bufferViews', [])
    images = doc.get('images', [])

    # 收集被 image 引用的 bufferView 索引
    img_bv = set()
    for im in images:
        if 'bufferView' in im:
            img_bv.add(im['bufferView'])

    # 解码并准备新的贴图字节
    new_img_bytes = {}
    conv = 0
    for im in images:
        bv_idx = im.get('bufferView')
        if bv_idx is None:
            continue
        bv = bvs[bv_idx]
        off = bv.get('byteOffset', 0)
        ln = bv['byteLength']
        raw = bin_bytes[off:off+ln]
        try:
            img = Image.open(BytesIO(raw))
            img = img.convert('RGB')  # 去掉 alpha（PBR 贴图 alpha 不用）
            w, h = img.size
            if max(w, h) > MAX_SIDE:
                scale = MAX_SIDE / max(w, h)
                img = img.resize((max(1, int(w*scale)), max(1, int(h*scale))), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format='JPEG', quality=QUALITY, optimize=True, progressive=True)
            new_img_bytes[bv_idx] = buf.getvalue()
            if im.get('mimeType') != 'image/jpeg':
                conv += 1
        except Exception as e:
            print(f'  ! 贴图#{bv_idx} 解码失败，保留原样: {e}')

    # 重建 BIN：按原 bufferView 顺序拼接，image 的替换为 JPEG。
    # 必须同时更新每个 bufferView 的 byteOffset，因为 image bufferView 变短后
    # 后续 bufferView 的偏移都会前移；否则几何数据会指向旧偏移（越界）导致车模消失。
    out = bytearray()
    for idx, bv in enumerate(bvs):
        old_off = bv.get('byteOffset', 0)
        old_len = bv['byteLength']
        bv['byteOffset'] = len(out)  # 新偏移
        if idx in new_img_bytes:
            chunk = new_img_bytes[idx]
            bv['byteLength'] = len(chunk)
            out += chunk
        else:
            out += bin_bytes[old_off:old_off + old_len]
        # 4 字节对齐
        while len(out) % 4 != 0:
            out += b'\x00'

    # 校验所有 bufferView 都在新 bin 范围内
    for idx, bv in enumerate(bvs):
        end = bv['byteOffset'] + bv['byteLength']
        if end > len(out):
            raise RuntimeError(f'bufferView[{idx}] ends at {end} but bin length is {len(out)}')

    # 更新 mimeType
    for im in images:
        if 'bufferView' in im:
            im['mimeType'] = 'image/jpeg'

    # 更新 buffer.byteLength
    if 'buffers' in doc and doc['buffers']:
        doc['buffers'][0]['byteLength'] = len(out)

    write_glb(doc, bytes(out), outp)
    before = Path(inp).stat().st_size
    after = Path(outp).stat().st_size
    print(f'  {Path(inp).name}: {before/1e6:.1f}MB -> {after/1e6:.1f}MB  (贴图转JPEG {conv}张)')

if __name__ == '__main__':
    main()
