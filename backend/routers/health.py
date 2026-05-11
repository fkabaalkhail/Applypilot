"""Health check endpoint."""

import os
from sqlalchemy import text
from fastapi import APIRouter
from backend.db.database import engine

router = APIRouter()


@router.get("/health")
async def health_check():
    checks = {}

    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        checks["database"] = True
    except Exception:
        checks["database"] = False

    checks["gemini"] = bool(os.getenv("GEMINI_API_KEY"))

    all_ok = all(checks.values())
    return {"status": "healthy" if all_ok else "degraded", "checks": checks}
