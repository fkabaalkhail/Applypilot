"""
Auto Apply Bot — FastAPI Application Entry Point

Runs startup health checks (Ollama, Redis, SQLite) and mounts all routers.
"""

import os
import sys
import httpx
import redis
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.db.database import engine, Base
from backend.routers import applications, jobs, resumes, health, settings


def _check(label: str, ok: bool) -> bool:
    """Print a colored check or cross for a startup dependency."""
    symbol = "\033[92m✔\033[0m" if ok else "\033[91m✘\033[0m"
    print(f"  {symbol} {label}")
    return ok


def run_startup_checks() -> None:
    """Ping Ollama, Redis, and confirm DB file — print status for each."""
    print("\n🔍 Startup checks:")
    all_ok = True

    # Ollama
    ollama_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    try:
        r = httpx.get(f"{ollama_url}/api/tags", timeout=5)
        all_ok &= _check("Ollama reachable", r.status_code == 200)
    except Exception:
        all_ok &= _check("Ollama reachable", False)

    # Redis
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    try:
        rc = redis.from_url(redis_url)
        rc.ping()
        all_ok &= _check("Redis reachable", True)
    except Exception:
        all_ok &= _check("Redis reachable", False)

    # SQLite DB directory
    db_path = os.getenv("DATABASE_URL", "sqlite:///./data/autoapply.db")
    if db_path.startswith("sqlite:///"):
        file_path = db_path.replace("sqlite:///", "")
        parent = Path(file_path).parent
        parent.mkdir(parents=True, exist_ok=True)
        all_ok &= _check("DB directory exists", parent.exists())
    else:
        all_ok &= _check("DB path configured", True)

    if not all_ok:
        print("\n⚠️  Some checks failed — the app will start but features may be degraded.\n")
    else:
        print("\n✅ All checks passed.\n")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: run startup checks and create DB tables."""
    run_startup_checks()
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title="Auto Apply Bot",
    version="0.1.0",
    description="AI-powered job application automation platform",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, tags=["health"])
app.include_router(resumes.router, prefix="/resumes", tags=["resumes"])
app.include_router(applications.router, prefix="/applications", tags=["applications"])
app.include_router(jobs.router, prefix="/jobs", tags=["jobs"])
app.include_router(settings.router, prefix="/settings", tags=["settings"])


@app.get("/debug/screenshot")
async def debug_screenshot():
    """Return the latest bot screenshot for debugging login issues."""
    from fastapi.responses import FileResponse
    from pathlib import Path
    screenshot = Path("data/linkedin_challenge.png")
    if screenshot.exists():
        return FileResponse(screenshot, media_type="image/png")
    return {"error": "No screenshot available. The bot hasn't hit a challenge yet."}


@app.get("/debug/before-submit")
async def debug_before_submit():
    """Return screenshot taken right before clicking Sign In."""
    from fastapi.responses import FileResponse
    from pathlib import Path
    screenshot = Path("data/linkedin_before_submit.png")
    if screenshot.exists():
        return FileResponse(screenshot, media_type="image/png")
    return {"error": "No pre-submit screenshot available yet."}


@app.get("/debug/search")
async def debug_search():
    """Return screenshot of the LinkedIn search results page."""
    from fastapi.responses import FileResponse
    from pathlib import Path
    screenshot = Path("data/linkedin_search.png")
    if screenshot.exists():
        return FileResponse(screenshot, media_type="image/png")
    return {"error": "No search screenshot available yet."}


@app.get("/debug/login")
async def debug_login():
    """Return screenshot of the LinkedIn login page."""
    from fastapi.responses import FileResponse
    from pathlib import Path
    screenshot = Path("data/linkedin_login_page.png")
    if screenshot.exists():
        return FileResponse(screenshot, media_type="image/png")
    return {"error": "No login screenshot available yet."}
