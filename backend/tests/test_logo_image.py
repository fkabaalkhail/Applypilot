"""normalize_logo: size/placeholder/visibility/shape guards + square 128px output."""

import hashlib
import io
import struct
import xml.etree.ElementTree as ET
import zlib

import pytest
from PIL import IcoImagePlugin, Image, ImageDraw

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


def _png_claiming(width: int, height: int) -> bytes:
    """A PNG whose IHDR declares width x height over a few bytes of data."""
    def chunk(kind: bytes, body: bytes) -> bytes:
        crc = zlib.crc32(kind + body) & 0xFFFFFFFF
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(b"\x00" * 64)) + chunk(b"IEND", b""))


def _ico_with(frame: bytes) -> bytes:
    """A one-frame ICO whose directory says 256x256 (it cannot say more)."""
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(frame), 6 + 16)
    return struct.pack("<HHH", 0, 1, 1) + entry + frame


@pytest.mark.parametrize("frame", [
    _png_claiming(8000, 8000),  # 64M px: under Pillow's own bomb check
    struct.pack("<IiiHH", 40, 9000, 18000, 1, 32) + b"\x00" * 64,  # BMP frame
], ids=["png-frame", "bmp-frame"])
def test_ico_bomb_is_refused_before_any_frame_is_decoded(monkeypatch, frame):
    """Pillow decodes an ICO's frame inside Image.open(), so the pixel cap
    has to be read from the frame headers first."""
    decoded = []
    real_frame = IcoImagePlugin.IcoFile.frame

    def spy(self, idx):
        decoded.append(idx)
        return real_frame(self, idx)

    monkeypatch.setattr(IcoImagePlugin.IcoFile, "frame", spy)
    ico = _ico_with(frame)
    assert normalize_logo(ico, "image/x-icon") is None
    assert image_size(ico) == (0, 0)
    assert decoded == []


def test_ico_with_a_normal_png_frame_still_decodes():
    big = Image.open(io.BytesIO(_logo(256))).convert("RGBA")
    logo = normalize_logo(_ico_with(_img_bytes(big)), "image/x-icon")
    assert logo is not None and (logo.width, logo.height) == (256, 256)


def test_only_logo_raster_formats_are_decoded():
    im = Image.open(io.BytesIO(_logo(160))).convert("RGBA")
    assert normalize_logo(_img_bytes(im, "BMP")) is not None
    assert normalize_logo(_img_bytes(im, "TIFF")) is None  # no logo endpoint serves TIFF
    assert normalize_logo(_img_bytes(im.convert("RGB"), "PPM")) is None


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

_XHTML = 'xmlns:h="http://www.w3.org/1999/xhtml"'
_EMBEDDED_SVG = "PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnLz4="
# Each of these got past the old sanitizer (it checked the parsed tree, then
# stored the raw bytes).
BYPASS_SVGS = {
    "xml-stylesheet-pi": b'<?xml-stylesheet type="text/xsl" href="https://evil.example/x.xsl"?>'
                         + _svg('<path d="M0 0h9v9z"/>'),
    "pi-after-xml-declaration": b'<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/x.css"?>'
                                + _svg('<path d="M0 0h9v9z"/>'),
    "pi-in-body": _svg('<?evil payload?><path d="M0 0h9v9z"/>'),
    "xhtml-meta-refresh": _svg('<h:meta http-equiv="refresh" content="0;url=https://evil.example"/>'
                               '<path d="M0 0h9v9z"/>', f'viewBox="0 0 100 100" {_XHTML}'),
    "xhtml-button-formaction": _svg('<h:form><h:button formaction="https://evil.example">x</h:button>'
                                    '</h:form><path d="M0 0h9v9z"/>', f'viewBox="0 0 100 100" {_XHTML}'),
    "xhtml-video-poster": _svg('<h:video poster="https://evil.example/p.png"/><path d="M0 0h9v9z"/>',
                               f'viewBox="0 0 100 100" {_XHTML}'),
    "use-svg-data-uri": _svg(f'<use href="data:image/svg+xml;base64,{_EMBEDDED_SVG}#x"/><path d="M0 0h9v9z"/>'),
    "image-svg-data-uri": _svg(f'<image href="data:image/svg+xml;base64,{_EMBEDDED_SVG}" width="9" height="9"/>'
                               '<path d="M0 0h9v9z"/>'),
    "css-escape-style-attr": _svg('<path d="M0 0h9v9z" style="fill:u\\72l(https://evil.example/x)"/>'),
    "css-escape-presentation-attr": _svg('<path d="M0 0h9v9z" fill="\\75 rl(https://evil.example/p.svg#g)"/>'),
    "css-image-set": _svg('<style>path{fill:red;background:image-set("https://evil.example/x.png" 1x)}</style>'
                          '<path d="M0 0h9v9z"/>'),
    "style-attr-import": _svg('<path d="M0 0h9v9z" style="@import \'https://evil.example/x.css\'"/>'),
    "css-font-face": _svg('<style>@font-face{font-family:x;src:local(Arial)}path{fill:red}</style>'
                          '<path d="M0 0h9v9z"/>'),
    "xml-base": _svg('<path d="M0 0h9v9z"/>', 'viewBox="0 0 100 100" xml:base="https://evil.example/"'),
    "foreign-namespace-attribute": _svg('<path xmlns:ev="http://www.w3.org/2001/xml-events" ev:event="click" '
                                        'd="M0 0h9v9z"/>'),
    "set-element": _svg('<path d="M0 0h9v9z"><set attributeName="fill" to="red"/></path>'),
    "unknown-svg-element": _svg('<blink/><path d="M0 0h9v9z"/>'),
    "utf16": _svg('<path d="M0 0h9v9z"/>').decode().encode("utf-16"),
    "utf16-entity": ('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE svg [<!ENTITY a "x">]>'
                     '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9"><text>&a;</text>'
                     '<path d="M0 0h9v9z"/></svg>').encode("utf-16"),
    "dtd-default-attribute": b'<!DOCTYPE svg [<!ATTLIST svg onload CDATA "alert(1)">]>'
                             + _svg('<path d="M0 0h9v9z"/>'),
}


@pytest.mark.parametrize("raw", list(UNSAFE_SVGS.values()), ids=list(UNSAFE_SVGS))
def test_svg_unsafe_or_broken_rejected(raw):
    assert normalize_logo(raw, "image/svg+xml") is None


@pytest.mark.parametrize("raw", list(BYPASS_SVGS.values()), ids=list(BYPASS_SVGS))
def test_svg_sanitizer_bypasses_rejected(raw):
    assert normalize_logo(raw, "image/svg+xml") is None


INKSCAPE_SVG = (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    '<!-- Created with Inkscape (http://www.inkscape.org/) -->\n'
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
    ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"'
    ' xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"'
    ' xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cc="http://creativecommons.org/ns#"'
    ' viewBox="0 0 100 100" xml:space="preserve" inkscape:version="1.3">'
    '<sodipodi:namedview id="nv" pagecolor="#ffffff"/>'
    '<metadata><rdf:RDF><cc:Work rdf:about=""/></rdf:RDF></metadata>'
    '<style><![CDATA[ g > path { fill: #123456 } '
    '@media (prefers-color-scheme: dark) { g > path { fill: #fff } } ]]></style>'
    '<defs><linearGradient id="a"><stop offset="0" stop-color="#123456"/></linearGradient>'
    '<linearGradient id="b" xlink:href="#a"/></defs>'
    '<g inkscape:label="Layer 1" inkscape:groupmode="layer">'
    '<path d="M0 0h100v100H0z" fill="url(#b)"/><text x="1" y="9">A &amp; B</text></g>'
    '</svg>'
).encode()


def test_svg_is_stored_as_the_sanitized_tree_not_the_input():
    logo = normalize_logo(INKSCAPE_SVG, "image/svg+xml")
    assert logo is not None and (logo.width, logo.height) == (100, 100)
    assert logo.sha == hashlib.sha1(logo.data).hexdigest()
    for gone in (b"<?", b"<!", b"inkscape", b"sodipodi", b"rdf", b"metadata", b"Created with"):
        assert gone not in logo.data
    root = ET.fromstring(logo.data)  # well-formed, and still an SVG document
    svg = "{http://www.w3.org/2000/svg}"
    assert root.tag == svg + "svg"
    assert root.get("{http://www.w3.org/XML/1998/namespace}space") == "preserve"
    linked = root.find(f"{svg}defs/{svg}linearGradient[@id='b']")
    assert linked.get("{http://www.w3.org/1999/xlink}href") == "#a"
    assert "g > path" in root.find(svg + "style").text  # CDATA kept as (escaped) text
    assert root.find(f"{svg}g/{svg}text").text == "A & B"
    # Idempotent: the stored copy passes the sanitizer unchanged.
    again = normalize_logo(logo.data, "image/svg+xml")
    assert again is not None and again.data == logo.data


def test_svg_all_white_or_banner_rejected():
    assert normalize_logo(_svg('<path d="M0 0h9v9z" fill="#FFF"/><path d="M1 1h2v2z" style="fill: white"/>')) is None
    assert normalize_logo(_svg('<path d="M0 0h9v9z"/>', 'viewBox="0 0 1000 100"')) is None
    # unpainted shapes default to black: visible
    assert normalize_logo(_svg('<path d="M0 0h9v9z"/>')) is not None
    # dimensions from width/height when there is no viewBox
    logo = normalize_logo(_svg('<path d="M0 0h9v9z" fill="red"/>', 'width="64px" height="48"'))
    assert logo is not None and (logo.width, logo.height) == (64, 48)
