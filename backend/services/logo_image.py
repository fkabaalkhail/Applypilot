"""
Logo image validation + normalization for self-hosted company logos.

Every harvested candidate passes through normalize_logo() before it can be
stored, so the feed only ever shows one shape: a square 128x128 PNG with a
transparent margin (or a sanitized SVG). The rules come from measuring what
actually rendered badly on prod:

- tiny favicons (< 64px on the longest side, after picking the largest ICO
  frame) upscale into a blur;
- known placeholder images (google s2's 16px globe, DuckDuckGo's default,
  GoDaddy's parked-domain logo) look like logos but are not the company's;
- images invisible on a white card (almost no opaque pixels, or only
  near-white ones), e.g. a white wordmark meant for a dark header;
- photos and social banners: extreme aspect ratios always, and og-style
  1200x630 banners unless the source is a known logo endpoint (ATS
  wordmarks are wide by design and get trimmed + padded instead).

Single-colour logos are NOT rejected: most real logos are one colour.
"""

from __future__ import annotations

import hashlib
import io
import logging
import math
import re
import xml.etree.ElementTree as ET
from typing import NamedTuple

from PIL import Image, ImageChops

logger = logging.getLogger(__name__)

LOGO_SIZE = 128
MIN_SIDE = 64
MAX_RAW_BYTES = 5_000_000
MAX_SVG_BYTES = 100_000
_MAX_PIXELS = 40_000_000  # decompression-bomb guard, checked before decoding

# sha1(raw bytes)[:16] of images that are placeholders, not company logos.
PLACEHOLDER_SHAS = frozenset({
    "2d7c9b60d1e2b4f4",  # google s2 / gstatic 16px default globe
    "980aa215c45dd3b9",  # DuckDuckGo ip3 default icon
    "8a68796d002a04b8",  # GoDaddy parked-domain logo (served by s2 with HTTP 200)
})

# Aspect ratio (w/h) outside these bounds is a photo strip or a banner.
MAX_ASPECT = 4.0
MIN_ASPECT = 0.25
# og-style social banner: wide AND large. Allowed only from logo endpoints.
BANNER_ASPECT = 1.6
BANNER_MIN_WIDTH = 600

# Invisible-on-white thresholds.
_OPAQUE_ALPHA = 128
_MIN_OPAQUE_FRACTION = 0.02
_WHITE_LUMA = 240

_PAD_FRACTION = 0.06  # transparent margin on each side of the square


class NormalizedLogo(NamedTuple):
    data: bytes
    sha: str      # sha1 hex of data
    fmt: str      # 'png' or 'svg'
    width: int    # original decoded size
    height: int


def raw_sha16(raw: bytes) -> str:
    return hashlib.sha1(raw).hexdigest()[:16]


def is_placeholder(raw: bytes) -> bool:
    return raw_sha16(raw) in PLACEHOLDER_SHAS


def _looks_like_svg(raw: bytes, content_type: str | None) -> bool:
    if "svg" in (content_type or "").lower():
        return True
    head = raw[:2048].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in head) or (
        head.startswith(b"<!--") and b"<svg" in raw[:4096].lower()
    )


def _looks_like_html(raw: bytes, content_type: str | None) -> bool:
    if "text/html" in (content_type or "").lower():
        return True
    head = raw[:512].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return head.startswith((b"<!doctype html", b"<html", b"<head", b"<body"))


def _aspect_ok(width: float, height: float, allow_wide: bool) -> bool:
    if width <= 0 or height <= 0:
        return False
    aspect = width / height
    if aspect > MAX_ASPECT or aspect < MIN_ASPECT:
        return False
    if not allow_wide and aspect > BANNER_ASPECT and width >= BANNER_MIN_WIDTH:
        return False
    return True


# --- raster ---------------------------------------------------------------

def _decode(raw: bytes) -> Image.Image | None:
    """Decoded image (largest frame for ICO, first frame otherwise), or None."""
    try:
        im = Image.open(io.BytesIO(raw))
        if im.width * im.height > _MAX_PIXELS:
            return None
        if (im.format or "").upper() == "ICO":
            sizes = im.ico.sizes()
            if sizes:
                im = im.ico.getimage(max(sizes, key=lambda s: s[0] * s[1]))
        elif getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        im.load()
        return im
    except Exception:
        return None


def image_size(raw: bytes, content_type: str | None = None) -> tuple[int, int]:
    """(width, height) of an image's bytes, (0, 0) when undecodable.

    ICO reports its largest frame; SVG its viewBox/width/height."""
    if _looks_like_svg(raw, content_type):
        root = _parse_svg(raw)
        return _svg_size(root) if root is not None else (0, 0)
    im = _decode(raw)
    return im.size if im is not None else (0, 0)


def _invisible_on_white(rgba: Image.Image) -> bool:
    """Too few opaque pixels, or only near-white ones: a white card hides it."""
    alpha = rgba.getchannel("A")
    opaque_mask = alpha.point(lambda a: 255 if a >= _OPAQUE_ALPHA else 0)
    opaque = opaque_mask.histogram()[255]
    if opaque < _MIN_OPAQUE_FRACTION * rgba.width * rgba.height:
        return True
    luma = rgba.convert("RGB").convert("L")
    # Transparent pixels become white so only opaque ones can lower the min.
    visible = Image.composite(luma, Image.new("L", rgba.size, 255), opaque_mask)
    darkest, _ = visible.getextrema()
    return darkest > _WHITE_LUMA


def _content_box(rgba: Image.Image) -> tuple[int, int, int, int] | None:
    """Bounding box of the drawn logo: transparent margins are trimmed, and so
    is a uniform near-white border on opaque images (the 1200x630 Workday
    canvas around a wordmark). A coloured background is part of the design
    (app-icon tiles) and is kept."""
    full = (0, 0, rgba.width, rgba.height)
    alpha = rgba.getchannel("A")
    if alpha.getextrema()[0] < 250:
        return alpha.point(lambda a: 255 if a > 16 else 0).getbbox()
    rgb = rgba.convert("RGB")
    w, h = rgb.size
    corners = [rgb.getpixel(p) for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    if any(min(c) < _WHITE_LUMA for c in corners):
        return full
    bg = Image.new("RGB", rgb.size, tuple(sum(c[i] for c in corners) // 4 for i in range(3)))
    diff = ImageChops.difference(rgb, bg).convert("L").point(lambda v: 255 if v > 20 else 0)
    return diff.getbbox() or full


def _normalize_raster(raw: bytes, allow_wide: bool) -> NormalizedLogo | None:
    im = _decode(raw)
    if im is None:
        return None
    width, height = im.size
    if max(width, height) < MIN_SIDE:
        return None
    if not _aspect_ok(width, height, allow_wide):
        return None
    try:
        rgba = im.convert("RGBA")
    except Exception:
        return None
    if _invisible_on_white(rgba):
        return None
    box = _content_box(rgba)
    if not box:
        return None
    content = rgba.crop(box)
    cw, ch = content.size
    side = math.ceil(max(cw, ch) / (1 - 2 * _PAD_FRACTION))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(content, ((side - cw) // 2, (side - ch) // 2))
    canvas = canvas.resize((LOGO_SIZE, LOGO_SIZE), Image.LANCZOS)
    out = io.BytesIO()
    canvas.save(out, format="PNG", optimize=True)
    data = out.getvalue()
    return NormalizedLogo(data, hashlib.sha1(data).hexdigest(), "png", width, height)


# --- svg ------------------------------------------------------------------

_SVG_NS = "http://www.w3.org/2000/svg"
# Elements that can run code, embed HTML or pull in other documents.
_SVG_BANNED_TAGS = {"script", "foreignobject", "iframe", "embed", "object", "handler", "listener"}
_DOCTYPE = re.compile(rb"<!DOCTYPE[^>\[]*>", re.IGNORECASE)
_CSS_URL = re.compile(r"url\(\s*['\"]?\s*([^'\")\s]+)", re.IGNORECASE)
_NUMBER = re.compile(r"[-+]?\d*\.?\d+")
_COLOR_ATTRS = ("fill", "stroke", "stop-color", "color")
_CSS_COLOR = re.compile(r"(?:fill|stroke|stop-color|color)\s*:\s*([^;}\"']+)", re.IGNORECASE)
_WHITE_NAMES = {"white", "#fff", "#ffffff", "#fefefe", "#fdfdfd", "#fcfcfc", "#fbfbfb", "#fafafa"}
_NO_PAINT = {"none", "transparent", "inherit", "currentcolor", ""}


def _local(name: str) -> str:
    return name.rsplit("}", 1)[-1].lower()


def _safe_ref(value: str) -> bool:
    """A reference an <img>-rendered SVG may keep: in-document or an inline image."""
    v = re.sub(r"\s+", "", value).lower()
    return v.startswith("#") or v.startswith("data:image/")


def _parse_svg(raw: bytes) -> ET.Element | None:
    if len(raw) > MAX_SVG_BYTES or b"<!ENTITY" in raw.upper():
        return None
    try:
        root = ET.fromstring(raw)
    except Exception:
        return None
    return root if root.tag == f"{{{_SVG_NS}}}svg" else None


def _svg_size(root: ET.Element) -> tuple[int, int]:
    box = _NUMBER.findall(root.get("viewBox") or "")
    if len(box) == 4:
        return round(float(box[2])), round(float(box[3]))
    try:
        w = float(_NUMBER.match((root.get("width") or "").strip()).group(0))
        h = float(_NUMBER.match((root.get("height") or "").strip()).group(0))
        return round(w), round(h)
    except (AttributeError, ValueError):
        return 0, 0


def _hex_luma(color: str) -> int | None:
    c = color.strip().lower()
    if c in _WHITE_NAMES:
        return 255
    m = re.fullmatch(r"#([0-9a-f]{3}|[0-9a-f]{6})", c)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        return round(0.299 * r + 0.587 * g + 0.114 * b)
    m = re.fullmatch(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)[^)]*\)", c)
    if m:
        r, g, b = (int(x) for x in m.groups())
        return round(0.299 * r + 0.587 * g + 0.114 * b)
    return None  # named colours / gradients: assume visible


def _svg_is_safe(root: ET.Element) -> bool:
    for el in root.iter():
        if not isinstance(el.tag, str) or _local(el.tag) in _SVG_BANNED_TAGS:
            return False
        for name, value in el.attrib.items():
            attr = _local(name)
            low = re.sub(r"[\s\x00-\x1f]+", "", value).lower()
            if attr.startswith("on") or "javascript:" in low or "vbscript:" in low:
                return False
            if attr in ("href", "src") and not _safe_ref(value):
                return False
            for ref in _CSS_URL.findall(value):
                if not _safe_ref(ref):
                    return False
        if _local(el.tag) == "style":
            css = "".join(el.itertext())
            if "@import" in css.lower() or "javascript:" in css.lower():
                return False
            if any(not _safe_ref(ref) for ref in _CSS_URL.findall(css)):
                return False
    return True


def _svg_all_white(root: ET.Element) -> bool:
    """Every explicit paint is near-white (unpainted shapes default to black)."""
    lumas: list[int] = []
    for el in root.iter():
        values = [el.get(a) for a in _COLOR_ATTRS if el.get(a) is not None]
        values += _CSS_COLOR.findall(el.get("style") or "")
        if _local(el.tag) == "style":
            values += _CSS_COLOR.findall("".join(el.itertext()))
        for v in values:
            if v.strip().lower() in _NO_PAINT or v.strip().lower().startswith("url("):
                continue
            luma = _hex_luma(v)
            if luma is None:
                return False
            lumas.append(luma)
    return bool(lumas) and min(lumas) > _WHITE_LUMA


def _normalize_svg(raw: bytes) -> NormalizedLogo | None:
    body = raw.lstrip(b"\xef\xbb\xbf \t\r\n")
    root = _parse_svg(body)
    if root is None or not _svg_is_safe(root) or _svg_all_white(root):
        return None
    width, height = _svg_size(root)
    # Vector art passes the pixel-size check; the shape rules still apply.
    if width and height and not _aspect_ok(width, height, allow_wide=True):
        return None
    data = _DOCTYPE.sub(b"", body, count=1)
    return NormalizedLogo(data, hashlib.sha1(data).hexdigest(), "svg", width, height)


def normalize_logo(
    raw: bytes, content_type: str | None = None, *, allow_wide: bool = False
) -> NormalizedLogo | None:
    """Validate a downloaded logo and return it as a square 128x128 PNG (or a
    sanitized SVG), or None when it is unusable.

    allow_wide: the bytes come from a known logo endpoint (ATS board logo,
    Workday /assets/logo), so a wide wordmark canvas is expected rather than a
    social banner."""
    if not raw or len(raw) > MAX_RAW_BYTES or is_placeholder(raw):
        return None
    try:
        if _looks_like_svg(raw, content_type):
            return _normalize_svg(raw)
        if _looks_like_html(raw, content_type):
            return None
        return _normalize_raster(raw, allow_wide)
    except Exception:
        logger.debug("normalize_logo failed", exc_info=True)
        return None
