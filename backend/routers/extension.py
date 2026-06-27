"""
Extension sync snapshot.

A single ``GET /api/extension/sync`` returns everything the Chrome extension
needs in one round-trip, plus a global ``version`` so the extension can cheaply
detect staleness (``GET /api/extension/sync/version``) and only re-download when
something actually changed. The web app is the source of truth; every synced
write bumps ``user_settings.data_version`` (see ``services/profile_version.py``),
which is the ``version`` returned here.

Large binaries (the original resume PDF/DOCX) are NOT inlined — the extension
fetches them on demand from ``GET /resumes/{id}/file`` and caches them locally.

Subscription + usage are returned as forward-compatible stubs (free tier) so the
contract is stable for when billing lands; no billing tables exist yet.
"""

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import CoverLetter, ResumeProfileDB, ResumeVersion, User, UserSettings
from backend.auth.dependencies import get_verified_user
from backend.routers.profile import ApplicationProfileOut, build_application_profile
from backend.services.profile_version import get_profile_version

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Response schema ─────────────────────────────────────────────────────────

class ResumeItem(BaseModel):
    id: int
    name: str
    isPrimary: bool = False
    hasFile: bool = False
    fileName: str = ""
    fileContentType: str = ""
    updatedAt: str | None = None


class CoverLetterItem(BaseModel):
    id: int
    jobTitle: str = ""
    company: str = ""
    text: str = ""
    tone: str = ""
    isActive: bool = False
    updatedAt: str | None = None


class CustomResumeItem(BaseModel):
    id: int
    label: str = ""
    jobId: int | None = None
    source: str = ""
    createdAt: str | None = None


class SubscriptionStub(BaseModel):
    tier: str = "free"
    status: str = "active"


class UsageStub(BaseModel):
    aiCreditsUsed: int = 0
    aiCreditsLimit: int | None = None


class ExtensionSettings(BaseModel):
    jobTitle: str = ""
    prefilledAnswers: dict = {}


class SyncSnapshot(BaseModel):
    version: int = 1
    updatedAt: str | None = None
    profile: ApplicationProfileOut
    resumes: list[ResumeItem] = []
    activeResumeId: int | None = None
    coverLetters: list[CoverLetterItem] = []
    customResumes: list[CustomResumeItem] = []
    settings: ExtensionSettings = ExtensionSettings()
    subscription: SubscriptionStub = SubscriptionStub()
    usage: UsageStub = UsageStub()


class SyncVersionOut(BaseModel):
    version: int = 1
    updatedAt: str | None = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


# ─── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/sync", response_model=SyncSnapshot)
def get_sync_snapshot(
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Return the full sync snapshot for the extension in one round-trip."""
    profile, _ = build_application_profile(user, db)

    resumes = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.user_id == user.id)
        .order_by(ResumeProfileDB.is_primary.desc(), ResumeProfileDB.created_at.desc())
        .all()
    )
    resume_items = [
        ResumeItem(
            id=r.id,
            name=r.name or "Untitled Resume",
            isPrimary=bool(r.is_primary),
            hasFile=bool(r.file_blob_url),
            fileName=r.file_name or "",
            fileContentType=r.file_content_type or "",
            updatedAt=_iso(r.updated_at),
        )
        for r in resumes
    ]
    active_resume_id = next((r.id for r in resumes if r.is_primary), None)
    if active_resume_id is None and resumes:
        active_resume_id = resumes[0].id

    cover_letters = (
        db.query(CoverLetter)
        .filter(CoverLetter.user_id == user.id)
        .order_by(CoverLetter.is_active.desc(), CoverLetter.updated_at.desc())
        .all()
    )
    cover_items = [
        CoverLetterItem(
            id=c.id,
            jobTitle=c.job_title or "",
            company=c.company or "",
            text=c.text or "",
            tone=c.tone or "",
            isActive=bool(c.is_active),
            updatedAt=_iso(c.updated_at),
        )
        for c in cover_letters
    ]

    custom_resumes = (
        db.query(ResumeVersion)
        .filter(ResumeVersion.user_id == user.id)
        .order_by(ResumeVersion.created_at.desc())
        .limit(50)
        .all()
    )
    custom_items = [
        CustomResumeItem(
            id=v.id,
            label=v.label or "",
            jobId=v.job_id,
            source=v.source or "",
            createdAt=_iso(v.created_at),
        )
        for v in custom_resumes
    ]

    settings = db.query(UserSettings).filter(UserSettings.user_id == user.id).first()
    ext_settings = ExtensionSettings(
        jobTitle=(settings.job_title if settings else "") or "",
        prefilledAnswers=(settings.prefilled_answers if settings and settings.prefilled_answers else {}),
    )

    version, updated_at = get_profile_version(db, user.id)

    return SyncSnapshot(
        version=version,
        updatedAt=_iso(updated_at),
        profile=profile,
        resumes=resume_items,
        activeResumeId=active_resume_id,
        coverLetters=cover_items,
        customResumes=custom_items,
        settings=ext_settings,
        subscription=SubscriptionStub(),
        usage=UsageStub(),
    )


@router.get("/sync/version", response_model=SyncVersionOut)
def get_sync_version(
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Cheap staleness check — the extension polls this and only pulls the full
    snapshot when ``version`` changed."""
    version, updated_at = get_profile_version(db, user.id)
    return SyncVersionOut(version=version, updatedAt=_iso(updated_at))
