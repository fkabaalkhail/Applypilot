"""Unsubscribe links for match-alert emails.

A match alert is a commercial electronic message under CASL (most users are
Canadian students), so every one must carry an opt-out that works without a
login, and the Privacy Policy already promised "the unsubscribe link in
emails". Before this, alerts had none: 91 went out, 57 of them to one user.
The endpoint (routers/settings.py) unsubscribes on POST: a mail client's
one-click button, or the confirm button on the page the footer link opens.

The link's token IS the credential. It is "<user_id>.<mac>", where mac is an
HMAC-SHA256 of the user id under a key derived from JWT_SECRET for this one
purpose. The derivation separates it from every JWT (a token can't be replayed
as, or forged from, an access or refresh token), and all a token can ever do
is switch off one account's match alerts, the very thing its holder was sent
it to do. It never expires: CASL wants the mechanism working for at least 60
days after a send, and an unsubscribe link in an old email should still work.
Rotating JWT_SECRET invalidates every outstanding link; the page then points
at the Settings toggle.
"""

import base64
import hashlib
import hmac
import os
from typing import Optional

# Served by the API (routers/settings.py). vercel.json already rewrites
# /settings/* to the backend, and the dev proxy forwards /settings, so the
# link works on the app's own origin.
UNSUBSCRIBE_PATH = "/settings/unsubscribe-alerts"

_PURPOSE = b"tailrd/match-alerts-unsubscribe/v1"
# Longest user id we'll parse; anything longer is garbage, not an account.
_MAX_ID_DIGITS = 12


def _key() -> bytes:
    secret = os.getenv("JWT_SECRET", "")
    if not secret:
        # backend.auth.tokens refuses to import without it too; never mint or
        # accept a token under an empty key.
        raise RuntimeError("JWT_SECRET is required for unsubscribe tokens")
    return hmac.new(secret.encode("utf-8"), _PURPOSE, hashlib.sha256).digest()


def _mac(user_id: int) -> str:
    digest = hmac.new(_key(), str(int(user_id)).encode("ascii"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def make_token(user_id: int) -> str:
    """The unsubscribe token for this account."""
    return f"{int(user_id)}.{_mac(user_id)}"


def verify_token(token: Optional[str]) -> Optional[int]:
    """The user id a genuine token names, or None for anything else."""
    raw_id, sep, mac = (token or "").strip().partition(".")
    # ASCII digits only: str.isdigit() also passes a superscript two, which
    # int() rejects (a 500 on an unauthenticated URL), and Arabic-Indic
    # digits, which int() reads as another spelling of a real id.
    if (not sep or not mac or not (raw_id.isascii() and raw_id.isdigit())
            or len(raw_id) > _MAX_ID_DIGITS):
        return None
    try:
        user_id = int(raw_id)
        expected = _mac(user_id)
    except (RuntimeError, ValueError):
        return None
    if not hmac.compare_digest(expected.encode("ascii"), mac.encode("ascii", "replace")):
        return None
    return user_id


def unsubscribe_url(user_id: int) -> str:
    """Absolute unsubscribe link for an email, or "" when FRONTEND_URL is unset
    (a relative link can't work in a mail client)."""
    base = (os.getenv("FRONTEND_URL") or "").rstrip("/")
    if not base:
        return ""
    return f"{base}{UNSUBSCRIBE_PATH}?token={make_token(user_id)}"
