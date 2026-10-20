import zlib, struct, base64, os

W, H = 64, 48
rows = []
for y in range(H):
    row = bytearray()
    for x in range(W):
        r = int(255 * x / (W - 1))
        g = int(255 * y / (H - 1))
        b = 128
        # альфа: круг в центре
        dx, dy = x - W / 2, y - H / 2
        a = 255 if dx * dx + dy * dy < 18 * 18 else 0
        row += bytes([r, g, b, a])
    rows.append(b'\x00' + bytes(row))
raw = zlib.compress(b''.join(rows), 9)

def chunk(t, d):
    c = struct.pack('>I', len(d)) + t + d
    return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', raw)
png += chunk(b'IEND', b'')

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, 'sample.png'), 'wb') as f:
    f.write(png)

print(base64.b64encode(png).decode())
