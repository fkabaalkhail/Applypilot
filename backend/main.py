"""
ApplyPilot — FastAPI Backend

Serves AI endpoints for the Chrome extension and React frontend.
Runs as Vercel serverless function or standalone with uvicorn.
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.db.database import engine, Base
from backend.routers import health, resumes, jobs, settings, fill, ai, apply, connections, github_sources
from backend.routers import auth
from backend.routers.feedback import router as feedback_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title="ApplyPilot API",
    version="0.2.0",
    description="AI-powered form filling API for the ApplyPilot extension",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,chrome-extension://*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, tags=["health"])
app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(fill.router, prefix="/api", tags=["fill"])
app.include_router(resumes.router, prefix="/resumes", tags=["resumes"])
app.include_router(jobs.router, prefix="/jobs", tags=["jobs"])
app.include_router(settings.router, prefix="/settings", tags=["settings"])
app.include_router(ai.router, prefix="/ai", tags=["ai"])
app.include_router(apply.router, prefix="/apply", tags=["apply"])
app.include_router(connections.router, prefix="/connections", tags=["connections"])
app.include_router(github_sources.router, prefix="/github-sources", tags=["github-sources"])
app.include_router(feedback_router)
