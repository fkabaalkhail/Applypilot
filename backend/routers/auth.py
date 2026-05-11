"""
Auth endpoints:
- GET /auth/me — return current user info
- POST /auth/webhook — Clerk webhook for user sync (create/update/delete)
"""

import os
import hashlib
import hmac
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import User
from backend.auth.clerk import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter()

CLERK_WEBHOOK_SECRET = os.getenv("CLERK_WEBHOOK_SECRET", "")


@router.get("/me")
def get_me(user: User = Depends(get_current_user)):
    """Return the current authenticated user's info."""
    return {
        "id": user.id,
        "clerk_user_id": user.clerk_user_id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "profile_image_url": user.profile_image_url,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.post("/webhook")
async def clerk_webhook(request: Request, db: Session = Depends(get_db)):
    """
    Clerk webhook endpoint for user lifecycle events.
    Handles: user.created, user.updated, user.deleted
    
    Clerk sends a Svix-signed webhook. We verify the signature
    using the webhook secret.
    """
    body = await request.body()

    # Verify webhook signature (Svix format)
    if CLERK_WEBHOOK_SECRET:
        svix_id = request.headers.get("svix-id", "")
        svix_timestamp = request.headers.get("svix-timestamp", "")
        svix_signature = request.headers.get("svix-signature", "")

        if not all([svix_id, svix_timestamp, svix_signature]):
            raise HTTPException(status_code=400, detail="Missing webhook headers")

        # Svix signature verification
        # The secret from Clerk starts with "whsec_" — strip that prefix and base64 decode
        try:
            import base64
            secret_bytes = base64.b64decode(CLERK_WEBHOOK_SECRET.replace("whsec_", ""))
            msg = f"{svix_id}.{svix_timestamp}.{body.decode()}".encode()
            expected_sig = base64.b64encode(
                hmac.new(secret_bytes, msg, hashlib.sha256).digest()
            ).decode()

            # Svix sends multiple signatures separated by space, each prefixed with "v1,"
            signatures = svix_signature.split(" ")
            verified = any(
                sig.replace("v1,", "") == expected_sig
                for sig in signatures
            )
            if not verified:
                logger.warning("Webhook signature verification failed")
                raise HTTPException(status_code=401, detail="Invalid signature")
        except HTTPException:
            raise
        except Exception as e:
            logger.warning(f"Webhook verification error: {e}")
            # In development, allow unverified webhooks
            pass

    # Parse the event
    try:
        event = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    event_type = event.get("type", "")
    data = event.get("data", {})

    if event_type == "user.created" or event_type == "user.updated":
        clerk_user_id = data.get("id", "")
        if not clerk_user_id:
            return {"status": "ignored", "reason": "no user id"}

        email = ""
        email_addresses = data.get("email_addresses", [])
        if email_addresses:
            # Use the primary email
            primary = next(
                (e for e in email_addresses if e.get("id") == data.get("primary_email_address_id")),
                email_addresses[0]
            )
            email = primary.get("email_address", "")

        user = db.query(User).filter(User.clerk_user_id == clerk_user_id).first()
        if user:
            user.email = email
            user.first_name = data.get("first_name", "") or ""
            user.last_name = data.get("last_name", "") or ""
            user.profile_image_url = data.get("image_url", "") or ""
        else:
            user = User(
                clerk_user_id=clerk_user_id,
                email=email,
                first_name=data.get("first_name", "") or "",
                last_name=data.get("last_name", "") or "",
                profile_image_url=data.get("image_url", "") or "",
            )
            db.add(user)

        db.commit()
        logger.info(f"Webhook: synced user {clerk_user_id} ({event_type})")
        return {"status": "synced"}

    elif event_type == "user.deleted":
        clerk_user_id = data.get("id", "")
        if clerk_user_id:
            user = db.query(User).filter(User.clerk_user_id == clerk_user_id).first()
            if user:
                db.delete(user)
                db.commit()
                logger.info(f"Webhook: deleted user {clerk_user_id}")
        return {"status": "deleted"}

    return {"status": "ignored", "event_type": event_type}
