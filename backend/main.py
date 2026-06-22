"""
ApplyPilot — FastAPI Backend

Serves AI endpoints for the Chrome extension and React frontend.
Runs as Vercel serverless function or standalone with uvicorn.
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from backend.db.database import engine, Base
from backend.migrations.add_email_verification import run_migration
from backend.migrations.add_admin_role import run_migration as run_admin_migration
from backend.migrations.add_security_fields import run_migration as run_security_migration
from backend.routers import health, resumes, jobs, settings, fill, ai, apply, connections, github_sources, profile
from backend.routers import auth
from backend.routers.feedback import router as feedback_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    run_migration()
    run_admin_migration()
    run_security_migration()
    yield


app = FastAPI(
    title="ApplyPilot API",
    version="0.2.0",
    description="AI-powered form filling API for the ApplyPilot extension",
    lifespan=lifespan,
)

# --- CORS Configuration ---
# Restrict origins to known frontends. Use CORS_ORIGINS env var in production.
_default_origins = "http://localhost:5173"
_cors_origins = os.getenv("CORS_ORIGINS", _default_origins).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# --- Security Headers Middleware ---
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "0"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    # HSTS — only enable if behind HTTPS in production
    if os.getenv("ENVIRONMENT", "development") == "production":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


app.include_router(health.router, tags=["health"])
app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(fill.router, prefix="/api", tags=["fill"])
app.include_router(profile.router, prefix="/api", tags=["profile"])
app.include_router(resumes.router, prefix="/resumes", tags=["resumes"])
app.include_router(jobs.router, prefix="/jobs", tags=["jobs"])
app.include_router(settings.router, prefix="/settings", tags=["settings"])
app.include_router(ai.router, prefix="/ai", tags=["ai"])
app.include_router(apply.router, prefix="/apply", tags=["apply"])
app.include_router(connections.router, prefix="/connections", tags=["connections"])
app.include_router(github_sources.router, prefix="/github-sources", tags=["github-sources"])
app.include_router(feedback_router)
