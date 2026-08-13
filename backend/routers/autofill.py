"""
Autofill telemetry + server-side override rules.

POST /autofill/telemetry          → record one autofill pass (which fields failed)
GET  /autofill/telemetry/summary  → per-host aggregates (admin), where to author rules
GET  /autofill/overrides          → enabled override rules + a version (extension polls)

Telemetry is the signal that tells us which sites break; overrides are the
hot-fix we apply in response, without shipping a new extension. Telemetry stores
field labels + outcomes only, never the user's answer values.
"""

import hashlib
import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import AutofillReport, AutofillOverride, AutofillFieldCapture, UserSettings
from backend.auth.dependencies import get_verified_user_id, get_admin_user_id

router = APIRouter()

# A single form does not have 500 fields; anything past this is a runaway page
# (an infinite-scroll list, a mis-scoped scan) and storing it helps nobody.
MAX_CAPTURES_PER_REPORT = 150
# Snapshots are already capped client-side; this is the server's own ceiling so
# a modified client cannot post megabytes of markup.
MAX_DOM_CHARS = 8000


def _diagnostic_enabled(db: Session, user_id: int) -> bool:
    """Whether THIS account opted into storing answers + employer markup."""
    row = (
        db.query(UserSettings.diagnostic_capture)
        .filter(UserSettings.user_id == user_id)
        .first()
    )
    return bool(row and row[0])


# ── Telemetry ────────────────────────────────────────────────────────────────

class FailedField(BaseModel):
    label: str = ""
    category: str = ""
    reason: str = ""


class FieldOutcome(BaseModel):
    """What happened to ONE field, whether or not it worked.

    Labels, categories, provenance and booleans only. `observedValuePresent` is
    a boolean precisely so the answer itself never has to be transmitted to say
    whether the page ended up holding one.
    """
    label: str = ""
    category: str = ""
    # "profile" | "backend" | "device" | "user"
    tier: str = ""
    # "derived" | "rule" | "ai" | ""  ("pass" is a Python keyword)
    pass_: str = Field(default="", alias="pass")
    expected_value_present: bool = False
    observed_value_present: bool = False
    # filled | failed | reverted | dropped | skipped
    outcome: str = ""
    reason: str = ""

    model_config = {"populate_by_name": True}


class FieldCapture(BaseModel):
    """The FULL record of one field, stored only for opted-in accounts.

    Everything here exists because its absence blocked a real diagnosis:
    `control_type` (Greenhouse renders no <select> at all, which cost a live
    page fetch to find out), `options` (the Degree list had to be guessed at),
    `proposed_value` (a wrong answer was only caught because its CATEGORY looked
    odd for the label), `help_text` (the documented "trap"), and `dom` (the only
    thing that lets a form be rebuilt as a fixture later).
    """
    field_id: str = ""
    label: str = ""
    category: str = ""
    confidence: float = 0
    control_type: str = ""
    input_type: str = ""
    help_text: str = ""
    required: bool = False
    group_index: int | None = None
    options: list[str] = Field(default_factory=list)
    proposed_value: str = ""
    observed_value: str = ""
    redacted: bool = False
    tier: str = ""
    pass_: str = Field(default="", alias="pass")
    outcome: str = ""
    reason: str = ""
    dom: str = ""
    selector: str = ""

    model_config = {"populate_by_name": True}


class FillDurations(BaseModel):
    scan_ms: int = 0
    local_ms: int = 0
    backend_ms: int = 0
    reask_ms: int = 0
    total_ms: int = 0


class TelemetryReport(BaseModel):
    host: str
    ats_type: str = ""
    url: str = ""
    total_fields: int = 0
    filled: int = 0
    failed: int = 0
    skipped: int = 0
    failed_fields: list[FailedField] = Field(default_factory=list)
    # Optional so an older extension build keeps reporting successfully.
    field_outcomes: list[FieldOutcome] = Field(default_factory=list)
    reverted: int = 0
    extension_version: str = ""
    durations: FillDurations | None = None
    # Diagnostic mode only. Sent by the client, but ACCEPTED only when the
    # account's own flag is on, see record_telemetry: a client cannot opt itself
    # into having its answers stored.
    field_captures: list[FieldCapture] = Field(default_factory=list)


@router.post("/telemetry")
def record_telemetry(
    report: TelemetryReport,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Record one autofill pass. Best-effort, a blank host is silently ignored."""
    host = (report.host or "").strip().lower()
    if not host:
        return {"status": "skipped"}
    row = AutofillReport(
        user_id=user_id,
        host=host[:255],
        ats_type=(report.ats_type or "")[:80],
        url=((report.url or "")[:1000]) or None,
        total_fields=max(0, report.total_fields),
        filled=max(0, report.filled),
        failed=max(0, report.failed),
        skipped=max(0, report.skipped),
        failed_fields=[f.model_dump() for f in report.failed_fields[:50]],
        field_outcomes=[
            f.model_dump(by_alias=True) for f in report.field_outcomes[:100]
        ],
        reverted=max(0, report.reverted),
        extension_version=(report.extension_version or "")[:80],
        durations=report.durations.model_dump() if report.durations else {},
    )
    db.add(row)
    db.flush()  # need row.id for the capture rows

    # Diagnostic capture is authorised by the SERVER's copy of the flag, never
    # by the client sending captures. Otherwise any caller could opt an account
    # into having its answers stored simply by posting them.
    captured = 0
    if report.field_captures and _diagnostic_enabled(db, user_id):
        for c in report.field_captures[:MAX_CAPTURES_PER_REPORT]:
            db.add(AutofillFieldCapture(
                report_id=row.id,
                user_id=user_id,
                host=host[:255],
                ats_type=(report.ats_type or "")[:80],
                url=(report.url or "")[:1000],
                field_id=(c.field_id or "")[:120],
                label=(c.label or "")[:2000],
                category=(c.category or "")[:80],
                confidence=c.confidence,
                control_type=(c.control_type or "")[:40],
                input_type=(c.input_type or "")[:40],
                help_text=(c.help_text or "")[:2000],
                required=c.required,
                group_index=c.group_index,
                options=c.options[:200],
                proposed_value=(c.proposed_value or "")[:2000],
                observed_value=(c.observed_value or "")[:2000],
                redacted=c.redacted,
                tier=(c.tier or "")[:40],
                pass_=(c.pass_ or "")[:40],
                outcome=(c.outcome or "")[:40],
                reason=(c.reason or "")[:1000],
                dom=(c.dom or "")[:MAX_DOM_CHARS],
                selector=(c.selector or "")[:400],
            ))
            captured += 1

    db.commit()
    return {"status": "ok", "captured": captured}


class HostSummary(BaseModel):
    host: str
    passes: int
    total_fields: int
    filled: int
    failed: int
    fail_rate: float


@router.get("/telemetry/summary", response_model=list[HostSummary])
def telemetry_summary(
    _admin: int = Depends(get_admin_user_id),
    days: int = Query(30, ge=1, le=365),
    db: Session = Depends(get_db),
):
    """Per-host fill aggregates, worst fail-rate first, where overrides pay off."""
    since = datetime.datetime.utcnow() - datetime.timedelta(days=days)
    rows = (
        db.query(
            AutofillReport.host,
            func.count(AutofillReport.id),
            func.sum(AutofillReport.total_fields),
            func.sum(AutofillReport.filled),
            func.sum(AutofillReport.failed),
        )
        .filter(AutofillReport.created_at >= since)
        .group_by(AutofillReport.host)
        .all()
    )
    out = []
    for host, passes, total, filled, failed in rows:
        total = total or 0
        failed = failed or 0
        out.append(
            HostSummary(
                host=host,
                passes=passes or 0,
                total_fields=total,
                filled=filled or 0,
                failed=failed,
                fail_rate=round(failed / total, 3) if total else 0.0,
            )
        )
    out.sort(key=lambda h: (h.fail_rate, h.failed), reverse=True)
    return out


# ── Server-side overrides (hot-fix layer) ────────────────────────────────────

class OverrideRule(BaseModel):
    host: str
    label_pattern: str
    category: str = ""
    value_synonyms: dict[str, str] = Field(default_factory=dict)

    model_config = {"from_attributes": True}


class OverridesResponse(BaseModel):
    version: str
    rules: list[OverrideRule]


class DiagnosticResponse(BaseModel):
    enabled: bool


@router.get("/diagnostic", response_model=DiagnosticResponse)
def get_diagnostic_mode(
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Whether THIS account has diagnostic capture on.

    Separate from /overrides on purpose: that endpoint is public (classification
    runs before the user is known), and whether an account stores its own
    answers is per-user and must be authenticated. The extension asks before it
    captures, so an account that never opted in transmits no answers and no
    markup at all, rather than sending them and trusting the server to discard.
    """
    return DiagnosticResponse(enabled=_diagnostic_enabled(db, user_id))


@router.get("/overrides", response_model=OverridesResponse)
def get_overrides(db: Session = Depends(get_db)):
    """Enabled override rules + a content hash. The extension caches by version
    and only re-applies when it changes. Public: these are field-mapping hints,
    not user data, and classification runs before the user is even known."""
    rows = (
        db.query(AutofillOverride)
        .filter(AutofillOverride.enabled == True)  # noqa: E712
        .order_by(AutofillOverride.id.asc())
        .all()
    )
    rules = [OverrideRule.model_validate(r) for r in rows]
    basis = "|".join(
        f"{r.host}::{r.label_pattern}::{r.category}::{sorted(r.value_synonyms.items())}"
        for r in rules
    )
    version = hashlib.sha256(basis.encode()).hexdigest()[:16] if rules else "empty"
    return OverridesResponse(version=version, rules=rules)
