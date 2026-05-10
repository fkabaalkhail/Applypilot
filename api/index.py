"""
Vercel serverless entry point.

Mounts the FastAPI app as a single catch-all function.
All /api/* routes are handled by this file.
"""

from backend.main import app

# Vercel expects a variable named `app` or `handler`
# FastAPI is ASGI-compatible, Vercel handles it natively
