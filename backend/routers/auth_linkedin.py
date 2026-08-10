"""
LinkedIn "Sign In with LinkedIn using OpenID Connect", authorization-code flow.

Unlike Google (which returns an ID token to the browser via the GIS SDK),
LinkedIn requires a server-side code exchange with a client secret:

  GET /auth/linkedin/start     -> 302 to LinkedIn authorize (sets state cookie)
  GET /auth/linkedin/callback  -> verify state, exchange code, upsert user,
                                  set the refresh cookie, 302 to the SPA
                                  /linkedin/complete

The SPA landing (/linkedin/complete) hydrates the session from the refresh
cookie via POST /auth/refresh, so the access token never appears in a URL.
NOTE: the SPA landing path must NOT be under /auth/*, vercel.json rewrites
/auth/(.*) to this API.
"""

import logging
import os
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import User
from backend.auth.tokens import create_refresh_token
from backend.services import sessions as session_service
from backend.routers.auth import _set_refresh_cookie, IS_PRODUCTION

logger = logging.getLogger(__name__)
router = APIRouter()

LINKEDIN_CLIENT_ID = os.getenv("LINKEDIN_CLIENT_ID", "")
LINKEDIN_CLIENT_SECRET = os.getenv("LINKEDIN_CLIENT_SECRET", "")
LINKEDIN_REDIRECT_URI = os.getenv("LINKEDIN_REDIRECT_URI", "")

LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization"
LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo"

STATE_COOKIE = "li_oauth_state"
NEXT_COOKIE = "li_oauth_next"
# SPA landing that hydrates the session, deliberately NOT under /auth/*.
COMPLETE_PATH = "/linkedin/complete"


def _safe_next(next_path):
    """Only honor same-origin absolute paths (mirrors the frontend safeNextPath)."""
    if next_path and next_path.startswith("/") and not next_path.startswith("//"):
        return next_path
    return "/app"


def _exchange_code(code: str) -> dict:
    """Exchange an authorization code for LinkedIn tokens (returns token JSON)."""
    with httpx.Client(timeout=10.0) as client:
        resp = client.post(
            LINKEDIN_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": LINKEDIN_REDIRECT_URI,
                "client_id": LINKEDIN_CLIENT_ID,
                "client_secret": LINKEDIN_CLIENT_SECRET,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    resp.raise_for_status()
    return resp.json()


def _fetch_userinfo(access_token: str) -> dict:
    """Fetch OIDC userinfo claims for the signed-in LinkedIn member."""
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(
            LINKEDIN_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    return resp.json()


@router.get("/start")
def linkedin_start(next: str = "/app"):
    """Begin OAuth: set a CSRF state cookie and redirect to LinkedIn."""
    if not (LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET and LINKEDIN_REDIRECT_URI):
        logger.error("LinkedIn OAuth env vars are not set")
        raise HTTPException(status_code=500, detail="LinkedIn OAuth not configured on server")

    state = secrets.token_urlsafe(32)
    params = {
        "response_type": "code",
        "client_id": LINKEDIN_CLIENT_ID,
        "redirect_uri": LINKEDIN_REDIRECT_URI,
        "scope": "openid profile email",
        "state": state,
    }
    redirect = RedirectResponse(url=f"{LINKEDIN_AUTHORIZE_URL}?{urlencode(params)}", status_code=302)
    # samesite="lax" so the cookie is returned on LinkedIn's top-level GET
    # redirect back to /callback (a strict cookie would be dropped there).
    redirect.set_cookie(STATE_COOKIE, state, httponly=True, secure=IS_PRODUCTION,
                        samesite="lax", max_age=600, path="/auth")
    redirect.set_cookie(NEXT_COOKIE, _safe_next(next), httponly=True, secure=IS_PRODUCTION,
                        samesite="lax", max_age=600, path="/auth")
    return redirect


@router.get("/callback")
def linkedin_callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    li_oauth_state: str = Cookie(default=None),
    li_oauth_next: str = Cookie(default=None),
    db: Session = Depends(get_db),
):
    """Verify state, exchange the code, upsert the user, set the session, redirect."""
    if error:
        logger.warning("LinkedIn returned an error: %s", error)
        raise HTTPException(status_code=401, detail="LinkedIn sign-in was cancelled")
    if not code or not state or not li_oauth_state or not secrets.compare_digest(state.encode(), li_oauth_state.encode()):
        logger.warning("LinkedIn state mismatch or missing code")
        raise HTTPException(status_code=401, detail="Invalid or expired LinkedIn sign-in state")

    try:
        token_json = _exchange_code(code)
    except (httpx.HTTPError, ValueError) as e:
        logger.error("LinkedIn token exchange failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not complete LinkedIn sign-in")

    access = token_json.get("access_token")
    if not access:
        raise HTTPException(status_code=502, detail="LinkedIn did not return an access token")

    try:
        info = _fetch_userinfo(access)
    except (httpx.HTTPError, ValueError) as e:
        logger.error("LinkedIn userinfo fetch failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not read LinkedIn profile")

    email = info.get("email")
    if not email:
        raise HTTPException(status_code=401, detail="LinkedIn account has no email")

    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(
            email=email,
            hashed_password=None,
            auth_provider="linkedin",
            first_name=info.get("given_name", ""),
            last_name=info.get("family_name", ""),
            profile_image_url=info.get("picture", ""),
            email_verified=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        logger.info("New LinkedIn user registered: %s", user.email)
    else:
        if not user.profile_image_url and info.get("picture"):
            user.profile_image_url = info["picture"]
        if not user.first_name and info.get("given_name"):
            user.first_name = info["given_name"]
        if not user.last_name and info.get("family_name"):
            user.last_name = info["family_name"]
        if user.auth_provider == "local":
            user.auth_provider = "linkedin"
        if not user.email_verified:
            user.email_verified = True
        db.commit()
        db.refresh(user)

    web_session = session_service.start_session(db, user.id, "web", request)
    refresh_tok = create_refresh_token(user.id, client="web", sid=web_session.sid)

    next_path = _safe_next(li_oauth_next)
    redirect = RedirectResponse(url=f"{COMPLETE_PATH}?{urlencode({'next': next_path})}", status_code=302)
    _set_refresh_cookie(redirect, refresh_tok)
    redirect.delete_cookie(STATE_COOKIE, path="/auth")
    redirect.delete_cookie(NEXT_COOKIE, path="/auth")
    return redirect
