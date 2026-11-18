"""Write the app's launcher icons: a green dot on a dark square.

Used by build.py; also runs alone: python scripts/icons.py <app folder>
Uses only the standard library, so it needs no image packages.
"""
import struct
import sys
import zlib
from pathlib import Path


def png(size: int) -> bytes:
    bg = (12, 12, 12)
    fg = (0, 255, 0)
    radius = size * 0.18
    centre = (size - 1) / 2
    rows = []
    for y in range(size):
        row = bytearray([0])  # filter type: none
        for x in range(size):
            inside = (x - centre) ** 2 + (y - centre) ** 2 <= radius ** 2
            row += bytes(fg if inside else bg)
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
