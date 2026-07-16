"""Logo harvester: homepage icon declarations + Wikidata P154, size-guarded."""

import struct

import httpx
import pytest

from backend.services.logo_harvester import (
    harvest_from_homepage,
    harvest_from_wikidata,
    harvest_logo,
    image_width,
)


def _png(width: int, height: int = None) -> bytes:
    height = height or width
    return (
        b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR"
        + struct.pack(">II", width, height) + b"\x08\x06\x00\x00\x00" + b"\x00" * 16
    )


def test_image_width_decoders():
    assert image_width(_png(180)) == 180
    assert image_width(_png(16)) == 16
    assert image_width(b"GIF89a" + struct.pack("<HH", 64, 64) + b"\x00" * 20) == 64
    assert image_width(b"junk") == 0


class MockTransport(httpx.AsyncBaseTransport):
    def __init__(self, routes: dict):
        self.routes = routes  # url-fragment -> (status, content, content_type)

    async def handle_async_request(self, request):
        for fragment, (status, content, ctype) in self.routes.items():
            if fragment in str(request.url):
                return httpx.Response(status, content=content,
                                      headers={"content-type": ctype})
        return httpx.Response(404, content=b"")


HOMEPAGE = b"""
<html><head>
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<link rel="icon" href="/favicon.ico">
</head><body></body></html>
"""


@pytest.mark.asyncio
async def test_homepage_harvest_prefers_apple_touch_icon():
    transport = MockTransport({
        "apple-touch-icon.png": (200, _png(180), "image/png"),
        "www.acme.example/": (200, HOMEPAGE, "text/html"),
    })
    async with httpx.AsyncClient(transport=transport) as client:
        url = await harvest_from_homepage(client, "acme.example")
    assert url.endswith("/icons/apple-touch-icon.png")


@pytest.mark.asyncio
async def test_homepage_harvest_rejects_tiny_icons():
    transport = MockTransport({
        "apple-touch-icon.png": (200, _png(16), "image/png"),
        "www.acme.example/": (200, HOMEPAGE, "text/html"),
    })
    async with httpx.AsyncClient(transport=transport) as client:
        assert await harvest_from_homepage(client, "acme.example") == ""


WIKIDATA_SEARCH = (
    b'{"search": [{"id": "Q38676", "label": "Agnico Eagle Mines"}]}'
)
WIKIDATA_CLAIMS = (
    b'{"claims": {"P154": [{"mainsnak": {"datavalue": {"value": "Agnico-Eagle.svg"}}}]}}'
)


@pytest.mark.asyncio
async def test_wikidata_harvest_finds_logo():
    transport = MockTransport({
        "wbsearchentities": (200, WIKIDATA_SEARCH, "application/json"),
        "wbgetclaims": (200, WIKIDATA_CLAIMS, "application/json"),
        "commons.wikimedia.org": (200, _png(330, 170), "image/png"),
    })
    async with httpx.AsyncClient(transport=transport) as client:
        url = await harvest_from_wikidata(client, "Agnico Eagle")
    assert "Agnico-Eagle.svg" in url
    assert "width=256" in url


@pytest.mark.asyncio
async def test_wikidata_harvest_requires_label_match():
    transport = MockTransport({
        "wbsearchentities": (200, b'{"search": [{"id": "Q1", "label": "Zebra Corp"}]}',
                             "application/json"),
    })
    async with httpx.AsyncClient(transport=transport) as client:
        assert await harvest_from_wikidata(client, "Agnico Eagle") == ""


@pytest.mark.asyncio
async def test_harvest_logo_falls_back_homepage_then_wikidata():
    transport = MockTransport({
        # homepage 404s → wikidata succeeds
        "wbsearchentities": (200, WIKIDATA_SEARCH, "application/json"),
        "wbgetclaims": (200, WIKIDATA_CLAIMS, "application/json"),
        "commons.wikimedia.org": (200, _png(330, 170), "image/png"),
    })
    async with httpx.AsyncClient(transport=transport) as client:
        url = await harvest_logo(client, "agnicoeagle.com", "Agnico Eagle")
    assert "commons.wikimedia.org" in url
