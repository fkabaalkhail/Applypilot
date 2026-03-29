"""
Health check endpoint — mirrors startup checks for Docker healthcheck / monitoring.
"""

import os
import httpx
import redis
from pathlib import Path
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check():
    """Return status of all dependencies: Ollama, Redis, DB."""
    checks = {}

    # Ollama
    ollama_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    try:
        r = httpx.get(f"{ollama_url}/api/tags", timeout=5)
        checks["ollama"] = r.status_code == 200
    except Exception:
        checks["ollama"] = False

    # Redis
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    try:
        rc = redis.from_url(redis_url)
        rc.ping()
        checks["redis"] = True
    except Exception:
        checks["redis"] = False

    # DB
    db_path = os.getenv("DATABASE_URL", "sqlite:///./data/autoapply.db")
    if db_path.startswith("sqlite:///"):
        file_path = db_path.replace("sqlite:///", "")
        checks["database"] = Path(file_path).parent.exists()
    else:
        checks["database"] = True

    all_ok = all(checks.values())
    return {"status": "healthy" if all_ok else "degraded", "checks": checks}
