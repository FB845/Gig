#!/usr/bin/env python3
"""Generate simple PWA icons (bar-chart mark on a brand background) with no
third-party dependencies. Pure stdlib zlib + a minimal PNG encoder."""
import struct
import zlib
import os

# Brand colors
BG_TOP = (16, 24, 39)       # deep slate
BG_BOTTOM = (30, 41, 59)    # slightly lighter slate
ACCENT = (52, 211, 153)     # emerald
ACCENT2 = (96, 165, 250)    # blue
WHITE = (241, 245, 249)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_icon(size, maskable=False):
    # padding for maskable safe-zone
    pad = int(size * 0.18) if maskable else int(size * 0.10)
    px = bytearray()
    # radius for rounded corners (only visual on non-maskable)
    radius = 0 if maskable else int(size * 0.22)

    # bar chart geometry
    chart_left = pad
    chart_right = size - pad
    chart_bottom = size - pad
    chart_top = pad
    n_bars = 4
    gap = int((chart_right - chart_left) * 0.06)
    bar_w = ((chart_right - chart_left) - gap * (n_bars - 1)) // n_bars
    # heights as fractions (ascending trend)
    fracs = [0.42, 0.60, 0.78, 1.0]
    bars = []
    for i in range(n_bars):
        bx0 = chart_left + i * (bar_w + gap)
        bx1 = bx0 + bar_w
        bh = int((chart_bottom - chart_top) * fracs[i])
        by0 = chart_bottom - bh
        color = ACCENT if i == n_bars - 1 else ACCENT2 if i % 2 == 0 else ACCENT
        bars.append((bx0, bx1, by0, chart_bottom, color))

    rows = []
    for y in range(size):
        row = bytearray()
        row.append(0)  # filter type 0
        for x in range(size):
            # rounded corner mask
            if radius:
                cx = min(x, size - 1 - x)
                cy = min(y, size - 1 - y)
                if cx < radius and cy < radius:
                    dx = radius - cx
                    dy = radius - cy
                    if dx * dx + dy * dy > radius * radius:
                        row += bytes((0, 0, 0, 0))
                        continue
            # background vertical gradient
            t = y / (size - 1)
            r, g, b = lerp(BG_TOP, BG_BOTTOM, t)
            # draw bars
            for (bx0, bx1, by0, by1, color) in bars:
                if bx0 <= x < bx1 and by0 <= y < by1:
                    r, g, b = color
                    break
            # baseline
            base_y = chart_bottom
            if base_y <= y < base_y + max(2, size // 64) and chart_left <= x < chart_right:
                r, g, b = WHITE
            row += bytes((r, g, b, 255))
        rows.append(row)

    raw = b"".join(rows)
    return png_bytes(size, size, raw)


def png_bytes(width, height, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    specs = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-192.png", 192, True),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
        ("favicon-32.png", 32, False),
    ]
    for name, size, maskable in specs:
        data = make_icon(size, maskable)
        with open(os.path.join(OUT_DIR, name), "wb") as f:
            f.write(data)
        print(f"wrote {name} ({size}x{size}, {len(data)} bytes)")


if __name__ == "__main__":
    main()
