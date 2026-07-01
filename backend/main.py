"""
ApplyPilot — FastAPI Backend

Serves AI endpoints for the Chrome extension and React frontend.
Runs as Vercel serverless function or standalone with uvicorn.
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from backend.db.database import engine, Base
from backend.migrations.add_email_verification import run_migration
from backend.migrations.add_admin_role import run_migration as run_admin_migration
from backend.migrations.add_security_fields import run_migration as run_security_migration
from backend.migrations.add_extension_sync_fields import run_migration as run_extension_sync_migration
from backend.migrations.add_extension_auth_codes import run_migration as run_extension_auth_codes_migration
from backend.migrations.add_company_domain import run_migration as run_company_domain_migration
from backend.migrations.add_sessions import run_migration as run_sessions_migration
from backend.migrations.add_job_match_notifications import run_migration as run_job_match_notifications_migration
from backend.migrations.add_onboarding_field import run_migration as run_onboarding_migration
from backend.routers import health, resumes, jobs, settings, fill, ai, apply, connections, github_sources, profile, answers
from backend.routers import auth, auth_extension, extension, tailor, cover_letter
from backend.routers.feedback import router as feedback_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    run_migration()
    run_admin_migration()
    run_security_migration()
    run_extension_sync_migration()
    run_extension_auth_codes_migration()
    run_company_domain_migration()
    run_sessions_migration()
    run_job_match_notifications_migration()
    run_onboarding_migration()
    yield


_IS_PRODUCTION = os.getenv("ENVIRONMENT", "development") == "production"

# The interactive API docs (and the OpenAPI schema that powers them) expose the
# full surface of the API. Keep them on in development, but off in production
# unless explicitly re-enabled, so we don't hand attackers a map for free.
_DOCS_ENABLED = (not _IS_PRODUCTION) or os.getenv("ENABLE_DOCS", "").strip().lower() in ("1", "true", "yes")

# Reject oversized request bodies early. Resume PDFs are a few hundred KB; 10 MB
# leaves generous headroom while blocking obvious memory-exhaustion attempts.
try:
    MAX_REQUEST_BYTES = int(os.getenv("MAX_REQUEST_BYTES", str(10 * 1024 * 1024)))
except ValueError:
    MAX_REQUEST_BYTES = 10 * 1024 * 1024

app = FastAPI(
    title="ApplyPilot API",
    version="0.2.0",
    description="AI-powered form filling API for the ApplyPilot extension",
    lifespan=lifespan,
    docs_url="/docs" if _DOCS_ENABLED else None,
    redoc_url="/redoc" if _DOCS_ENABLED else None,
    openapi_url="/openapi.json" if _DOCS_ENABLED else None,
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


# --- Request Size Guard ---
# Reject obviously oversized bodies before they are read into memory. This only
# inspects the declared Content-Length; the platform still caps truly unbounded
# (chunked) uploads, so this is a cheap first line of defence, not the only one.
@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                return JSONResponse(
                    status_code=413,
                    content={"detail": "Request body too large."},
                )
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length."})
    return await call_next(request)


# --- Security Headers Middleware ---
_DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "0"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    # CSP: the API serves JSON, so it should load nothing and be framed by no one.
    # Swagger/ReDoc are HTML and pull their own assets, so relax CSP just for them.
    path = request.url.path
    if path.startswith(_DOCS_PATHS):
        response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
    else:
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
        )
    # HSTS — only enable if behind HTTPS in production
    if _IS_PRODUCTION:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


app.include_router(health.router, tags=["health"])
app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(auth_extension.router, prefix="/auth/extension", tags=["auth-extension"])
app.include_router(fill.router, prefix="/api", tags=["fill"])
app.include_router(answers.router, prefix="/api", tags=["answers"])
app.include_router(tailor.router, prefix="/api", tags=["tailor"])
app.include_router(cover_letter.router, prefix="/api", tags=["cover-letter"])
app.include_router(profile.router, prefix="/api", tags=["profile"])
app.include_router(extension.router, prefix="/api/extension", tags=["extension-sync"])
app.include_router(resumes.router, prefix="/resumes", tags=["resumes"])
app.include_router(jobs.router, prefix="/jobs", tags=["jobs"])
app.include_router(settings.router, prefix="/settings", tags=["settings"])
app.include_router(ai.router, prefix="/ai", tags=["ai"])
app.include_router(apply.router, prefix="/apply", tags=["apply"])
app.include_router(connections.router, prefix="/connections", tags=["connections"])
app.include_router(github_sources.router, prefix="/github-sources", tags=["github-sources"])
app.include_router(feedback_router)
