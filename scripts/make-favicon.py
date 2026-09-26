#!/usr/bin/env python3
"""Writes favicon.ico: a 32×32 PNG (calendar tile with a QR-ish corner) in
an ICO container. Standard library only; the result is committed, so this
runs only when the icon changes.  Usage: python3 scripts/make-favicon.py
"""
import struct
import zlib
from pathlib import Path

SIZE = 32
BG = (11, 87, 208, 255)      # accent blue
INK = (255, 255, 255, 255)   # white
DARK = (26, 26, 26, 255)


def pixel(x, y):
    # rounded-ish tile: drop the four corner pixels
    if (x in (0, SIZE - 1)) and (y in (0, SIZE - 1)):
        return (0, 0, 0, 0)
    # calendar header band
    if 3 <= y <= 8 and 2 <= x <= SIZE - 3:
        return INK
    # two binder rings
    if y in (1, 2) and x in (8, 9, 22, 23):
        return INK
    # QR-like finder square bottom-left: 7×7 with hollow ring
    if 12 <= x <= 18 and 12 <= y <= 18:
        ring = x in (12, 18) or y in (12, 18)
        core = 14 <= x <= 16 and 14 <= y <= 16
        return INK if (ring or core) else BG
    # a few "modules" to the right/below
    if (x, y) in {(21, 13), (23, 13), (25, 13), (21, 15), (25, 15), (21, 17), (23, 17), (25, 17),
                  (14, 21), (16, 21), (18, 21), (14, 23), (18, 23), (14, 25), (16, 25), (18, 25),
                  (22, 22), (24, 22), (22, 24), (26, 24), (24, 26)}:
        return INK
    if 2 <= x <= SIZE - 3 and 2 <= y <= SIZE - 3:
        return BG
    return (0, 0, 0, 0)


def png_bytes():
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(SIZE)) for y in range(SIZE))

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def main():
    png = png_bytes()
    header = struct.pack('<HHH', 0, 1, 1)
    entry = struct.pack('<BBBBHHII', SIZE, SIZE, 0, 0, 1, 32, len(png), 6 + 16)
    out = Path(__file__).resolve().parent.parent / 'favicon.ico'
    out.write_bytes(header + entry + png)
    print(f'wrote {out} ({len(png) + 22} bytes)')


if __name__ == '__main__':
    main()
