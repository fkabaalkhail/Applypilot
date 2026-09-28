"""normalize_logo: size/placeholder/visibility/shape guards + square 128px output."""

import hashlib
import io

import pytest
from PIL import Image, ImageDraw

import backend.services.logo_image as logo_image
from backend.services.logo_image import image_size, is_placeholder, normalize_logo


def _img_bytes(im: Image.Image, fmt: str = "PNG", **save_kw) -> bytes:
    out = io.BytesIO()
    im.save(out, format=fmt, **save_kw)
    return out.getvalue()


def _logo(w=180, h=None, fg=(20, 60, 200, 255), bg=(0, 0, 0, 0), fmt="PNG", box=None) -> bytes:
    """A shape drawn in the middle of a w x h canvas."""
    h = h or w
    mode = "RGBA" if fmt == "PNG" else "RGB"
    im = Image.new(mode, (w, h), bg if mode == "RGBA" else bg[:3])
    box = box or (w // 5, h // 5, w - w // 5, h - h // 5)
    ImageDraw.Draw(im).ellipse(box, fill=fg if mode == "RGBA" else fg[:3])
    return _img_bytes(im, fmt)


def _alpha_bbox(png: bytes):
    return Image.open(io.BytesIO(png)).convert("RGBA").getchannel("A").getbbox()


def test_normalizes_to_square_transparent_png():
    raw = _logo(300, 150)
    logo = normalize_logo(raw, "image/png")
    assert logo is not None
    assert logo.fmt == "png"
    assert (logo.width, logo.height) == (300, 150)  # original decoded size
    assert logo.sha == hashlib.sha1(logo.data).hexdigest()
    out = Image.open(io.BytesIO(logo.data))
    assert out.format == "PNG" and out.size == (128, 128) and out.mode == "RGBA"
    # Trimmed to the drawn shape, then centred with a small transparent margin.
    left, top, right, bottom = _alpha_bbox(logo.data)
    assert left <= 12 and right >= 116          # the wide side fills the square
    assert top > 20 and bottom < 108            # the short side is padded
    assert out.getpixel((0, 0))[3] == 0


def test_rejects_tiny_images():
    assert normalize_logo(_logo(32)) is None
    assert normalize_logo(_logo(63)) is None
    assert normalize_logo(_logo(64)) is not None


def test_rejects_known_placeholders(monkeypatch):
    assert {"2d7c9b60d1e2b4f4", "980aa215c45dd3b9", "8a68796d002a04b8"} <= logo_image.PLACEHOLDER_SHAS
    raw = _logo(180)
    assert normalize_logo(raw) is not None
    monkeypatch.setattr(
        logo_image, "PLACEHOLDER_SHAS",
        logo_image.PLACEHOLDER_SHAS | {hashlib.sha1(raw).hexdigest()[:16]},
    )
    assert is_placeholder(raw)
    assert normalize_logo(raw) is None


def test_rejects_images_invisible_on_white():
    # all-white opaque canvas
    assert normalize_logo(_img_bytes(Image.new("RGB", (200, 200), (255, 255, 255)), "JPEG")) is None
    # white wordmark on transparency (made for a dark header)
    assert normalize_logo(_logo(200, fg=(255, 255, 255, 255))) is None
    # near-white glyph with a faint dark shadow under the opacity threshold
    im = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle((40, 40, 160, 160), fill=(0, 0, 0, 60))
    ImageDraw.Draw(im).rectangle((50, 50, 150, 150), fill=(250, 250, 250, 255))
    assert normalize_logo(_img_bytes(im)) is None
    # a speck: under 2% of the canvas is opaque
    assert normalize_logo(_logo(200, box=(95, 95, 110, 110))) is None


def test_keeps_single_colour_logos():
    # one flat colour on transparency (Zscaler/Replit style)
    assert normalize_logo(_logo(200, fg=(0, 0, 0, 255))) is not None
    # one flat colour filling the whole opaque canvas (app tile)
    assert normalize_logo(_img_bytes(Image.new("RGB", (180, 180), (220, 30, 30)))) is not None


@pytest.mark.parametrize("size", [(500, 100), (100, 500), (1200, 250)])
def test_rejects_extreme_aspect_ratios_even_from_logo_endpoints(size):
    raw = _logo(*size, bg=(255, 255, 255, 255))
    assert normalize_logo(raw) is None
    assert normalize_logo(raw, allow_wide=True) is None


def test_og_banner_needs_logo_endpoint_and_is_trimmed():
    # Workday /assets/logo style: a wordmark centred on a white 1200x630 canvas.
    raw = _logo(1200, 630, fg=(220, 0, 0, 255), bg=(255, 255, 255, 255), fmt="JPEG",
                box=(300, 220, 900, 410))
    assert normalize_logo(raw, "image/jpeg") is None
    logo = normalize_logo(raw, "image/jpeg", allow_wide=True)
    assert logo is not None and (logo.width, logo.height) == (1200, 630)
    left, _, right, _ = _alpha_bbox(logo.data)
    assert left <= 12 and right >= 116  # the white canvas margin was trimmed away
    # a merely wide (not og-sized) logo needs no flag
    assert normalize_logo(_logo(400, 200)) is not None


def test_coloured_background_is_kept_not_trimmed():
    im = Image.new("RGB", (200, 200), (10, 40, 160))
    ImageDraw.Draw(im).ellipse((80, 80, 120, 120), fill=(255, 255, 255))
    logo = normalize_logo(_img_bytes(im))
    assert logo is not None
    out = Image.open(io.BytesIO(logo.data)).convert("RGBA")
    assert out.getpixel((20, 20))[:3] == (10, 40, 160)  # tile background survived


def test_ico_uses_largest_frame():
    big = Image.open(io.BytesIO(_logo(128))).convert("RGBA")
    ico = _img_bytes(big, "ICO", sizes=[(16, 16), (32, 32), (128, 128)])
    assert image_size(ico) == (128, 128)
    logo = normalize_logo(ico, "image/x-icon")
    assert logo is not None and (logo.width, logo.height) == (128, 128)
    small = _img_bytes(big, "ICO", sizes=[(16, 16), (32, 32)])
    assert normalize_logo(small, "image/x-icon") is None


def test_decodes_webp_and_gif():
    im = Image.open(io.BytesIO(_logo(160))).convert("RGBA")
    assert normalize_logo(_img_bytes(im, "WEBP")) is not None
    assert normalize_logo(_img_bytes(im.convert("P"), "GIF")) is not None


def test_rejects_html_and_junk():
    assert normalize_logo(b"<!DOCTYPE html><html><body>not found</body></html>") is None
    assert normalize_logo(b"\x89PNG\r\n\x1a\n" + b"\x00" * 40) is None  # truncated
    assert normalize_logo(b"") is None


SVG_OK = (
    b'<?xml version="1.0"?>\n'
    b'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'
    b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 120 100">'
    b'<defs><linearGradient id="g"><stop offset="0" stop-color="#123456"/></linearGradient></defs>'
    b'<path id="p" d="M0 0h120v100H0z" fill="url(#g)"/><use xlink:href="#p"/>'
    b'<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>'
    b"</svg>"
)


def test_svg_accepted_and_doctype_stripped():
    logo = normalize_logo(SVG_OK, "image/svg+xml")
    assert logo is not None
    assert logo.fmt == "svg" and (logo.width, logo.height) == (120, 100)
    assert b"<!DOCTYPE" not in logo.data and b"<svg" in logo.data
    assert logo.sha == hashlib.sha1(logo.data).hexdigest()
    assert image_size(SVG_OK) == (120, 100)


def _svg(inner: str, attrs: str = 'viewBox="0 0 100 100"') -> bytes:
    return f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" {attrs}>{inner}</svg>'.encode()


UNSAFE_SVGS = {
    "script": _svg('<script>alert(1)</script><path d="M0 0h9v9z"/>'),
    "onload": _svg('<path d="M0 0h9v9z"/>', 'viewBox="0 0 100 100" onload="alert(1)"'),
    "foreignObject": _svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
    "js-href": _svg('<a href="javascript:alert(1)"><path d="M0 0h9v9z"/></a>'),
    "js-href-obfuscated": _svg('<a href=" jav&#x09;ascript:alert(1)"><path d="M0 0h9v9z"/></a>'),
    "external-image": _svg('<image xlink:href="https://evil.example/x.png" width="9" height="9"/>'),
    "external-use": _svg('<use href="//evil.example/sprite.svg#a"/>'),
    "css-import": _svg('<style>@import url(https://evil.example/x.css);</style><path d="M0 0h9v9z"/>'),
    "css-external-url": _svg('<path d="M0 0h9v9z" style="fill:url(https://evil.example/p.svg#g)"/>'),
    "animate-js": _svg('<animate attributeName="href" to="javascript:alert(1)"/>'),
    "entity": b'<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    "no-namespace": b'<svg viewBox="0 0 10 10"><path d="M0 0h9v9z"/></svg>',  # never renders
    "too-big": _svg('<path d="M0 0h9v9z"/><!--' + "x" * 110_000 + "-->"),
}


@pytest.mark.parametrize("raw", list(UNSAFE_SVGS.values()), ids=list(UNSAFE_SVGS))
def test_svg_unsafe_or_broken_rejected(raw):
    assert normalize_logo(raw, "image/svg+xml") is None


def test_svg_all_white_or_banner_rejected():
    assert normalize_logo(_svg('<path d="M0 0h9v9z" fill="#FFF"/><path d="M1 1h2v2z" style="fill: white"/>')) is None
    assert normalize_logo(_svg('<path d="M0 0h9v9z"/>', 'viewBox="0 0 1000 100"')) is None
    # unpainted shapes default to black: visible
    assert normalize_logo(_svg('<path d="M0 0h9v9z"/>')) is not None
    # dimensions from width/height when there is no viewBox
    logo = normalize_logo(_svg('<path d="M0 0h9v9z" fill="red"/>', 'width="64px" height="48"'))
    assert logo is not None and (logo.width, logo.height) == (64, 48)
