"""Write the app's launcher icons: a green cross + dot crosshair on a dark square.

Used by build.py; also runs alone: python scripts/icons.py <app folder>
Uses only the standard library, so it needs no image packages.

The crosshair uses the renderer's cross + dot rules (render.js), in crosshair units: arms
ARM long starting GAP from the center, THICKNESS wide, and a center dot of 1.5 x thickness.
Edges are smoothed by sampling each pixel on a SAMPLES x SAMPLES grid.
"""
import struct
import sys
import zlib
from pathlib import Path

ARM = 4
THICKNESS = 2
GAP = 5
DOT = max(2, THICKNESS * 1.5)
FILL = 0.8          #Share of the icon the crosshair spans, edge to edge
SAMPLES = 4

BG = (12, 12, 12)
FG = (0, 255, 0)


def inside(x: float, y: float) -> bool:
    """Check if a point (crosshair units, center at 0,0) is on the crosshair."""
    half = THICKNESS / 2
    if x * x + y * y <= (DOT / 2) ** 2:
        return True
    #Horizontal arms, then vertical arms
    if abs(y) <= half and GAP <= abs(x) <= GAP + ARM:
        return True
    return abs(x) <= half and GAP <= abs(y) <= GAP + ARM


def png(size: int) -> bytes:
    scale = size * FILL / (2 * (GAP + ARM))     #Pixels per crosshair unit
    center = size / 2
    rows = []
    for py in range(size):
        row = bytearray([0])  #Filter type: none
        for px in range(size):
            hits = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    x = (px + (sx + 0.5) / SAMPLES - center) / scale
                    y = (py + (sy + 0.5) / SAMPLES - center) / scale
                    hits += inside(x, y)
            a = hits / (SAMPLES * SAMPLES)
            row += bytes(round(b + (f - b) * a) for b, f in zip(BG, FG))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def write(out: Path) -> None:
    (out / "icon.png").write_bytes(png(80))
    (out / "largeIcon.png").write_bytes(png(130))


def main() -> None:
    write(Path(sys.argv[1]))


if __name__ == "__main__":
    main()
