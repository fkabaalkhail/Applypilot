"""Every backend route must be routed to FastAPI by vercel.json.

Production serves the SPA and the API from one domain, split by the `rewrites`
list, which ends in a catch-all sending everything else to index.html. A router
mounted without a matching rewrite therefore does not 404 in production -- it
returns the SPA shell with status 200 to a GET, and 405 to a POST, from the
static host. The failure is invisible in every local test, because locally the
Vite proxy forwards those same paths to uvicorn.

This has already happened twice: `1800f26 fix(vercel): route /autofill/* to the
FastAPI backend`, and /feedback, whose submissions never once reached the
database. This test is the guard so there is no third time.
"""
import json
import re
from pathlib import Path

import pytest

from backend.main import app

VERCEL_JSON = Path(__file__).resolve().parents[2] / "vercel.json"

# Paths that are *supposed* to fall through to the single-page app: FastAPI's
# generated docs (not served in production) and the site root.
NOT_API = {"/", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}

PARAM = re.compile(r"\{[^}]+\}")


def _rewrites() -> list[tuple[str, str]]:
    config = json.loads(VERCEL_JSON.read_text(encoding="utf-8"))
    return [(r["source"], r["destination"]) for r in config["rewrites"]]


def _api_paths() -> list[str]:
    """Concrete request paths for every mounted API route, params filled in."""
    paths = {
        PARAM.sub("1", route.path)
        for route in app.routes
        if getattr(route, "path", None) and route.path not in NOT_API
    }
    return sorted(paths)


@pytest.mark.parametrize("path", _api_paths())
def test_route_is_rewritten_to_the_backend(path):
    """The first rewrite matching an API path must send it to the function.

    Vercel applies rewrites in order and stops at the first match, so this
    mirrors production by taking the first match rather than any match.
    """
    for source, destination in _rewrites():
        if re.fullmatch(source, path):
            assert destination == "/api/index.py", (
                f"{path} is served by the static site (matched rewrite {source!r} "
                f"-> {destination!r}). Requests never reach FastAPI."
            )
            return
    pytest.fail(f"{path} matches no rewrite in vercel.json")
