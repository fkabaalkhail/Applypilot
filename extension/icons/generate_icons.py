#!/usr/bin/env python3
"""
Generate placeholder PNG icons for the Chrome extension.
Creates Coronation Blue (#26265D) icons with a light ring at 16x16, 48x48, 128x128.
Uses only stdlib (struct + zlib). No PIL needed.

Run: python extension/icons/generate_icons.py
Replace these with real icons before publishing.
"""

import struct
import zlib
import os
import math

def create_png(width, height, r, g, b):
    """Create a minimal valid PNG with RGBA pixels."""
    raw_rows = []
    for y in range(height):
        row = b'\x00'  # filter byte: None
        for x in range(width):
            cx = x / width
            cy = y / height
            dist = math.sqrt((cx - 0.5) ** 2 + (cy - 0.5) ** 2)

            if width >= 48 and 0.30 < dist < 0.42:
                # Light ring accent
                row += struct.pack('BBBB', 0xB0, 0x92, 0x55, 0xFF)  # Matte Bronze
            elif width >= 48 and dist <= 0.30:
                # Inner circle slightly lighter
                row += struct.pack('BBBB', 0x30, 0x30, 0x70, 0xFF)
            else:
                # Background: Coronation Blue
                row += struct.pack('BBBB', r, g, b, 0xFF)
        raw_rows.append(row)

    raw_data = b''.join(raw_rows)
    compressed = zlib.compress(raw_data)

    def make_chunk(chunk_type, data):
        chunk = chunk_type + data
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xFFFFFFFF)

    # PNG signature
    signature = b'\x89PNG\r\n\x1a\n'

    # IHDR
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    ihdr = make_chunk(b'IHDR', ihdr_data)

    # IDAT
    idat = make_chunk(b'IDAT', compressed)

    # IEND
    iend = make_chunk(b'IEND', b'')

    return signature + ihdr + idat + iend


def main():
    out_dir = os.path.dirname(os.path.abspath(__file__))
    sizes = [16, 48, 128]
    r, g, b = 0x26, 0x26, 0x5D  # Coronation Blue

    for size in sizes:
        png_data = create_png(size, size, r, g, b)
        file_path = os.path.join(out_dir, f'icon{size}.png')
        with open(file_path, 'wb') as f:
            f.write(png_data)
        print(f'Created {file_path} ({len(png_data)} bytes)')

    print('Done! Replace these placeholder icons with real ones before publishing.')


if __name__ == '__main__':
    main()
