"""
Job scraping and application endpoints.

POST /jobs/scrape              — scrape LinkedIn for jobs matching filters
GET  /jobs                     — list scraped jobs with filters
POST /jobs/{id}/apply          — start auto-apply for a specific job
GET  /jobs/{id}/questions      — get pending questions for a job
POST /jobs/questions/{id}/answer — submit answer to a pending question
POST /jobs/{id}/resume-apply   — resume applying after answering questions
GET  /jobs/logs/{task_id}      — SSE stream of real-time bot logs
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import ScrapedJob, PendingQuestion, JobStatus, AutopilotRun, ApplicationRecord, ConnectionRequest
from backend.schemas.jobs import ScrapedJobOut, PendingQuestionOut, AnswerSubmit
from backend.schemas.application import ConnectionRequestOut
from backend.services.task_runner import (
    start_scrape_task, start_apply_task, start_analyze_task,
    start_autopilot_task, stop_autopilot_task, start_connect_task, stream_logs,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/scrape")
def scrape_jobs(db: Session = Depends(get_db), sync: bool = Query(False, description="Run synchronously without Celery")):
    """Kick off a scrape task — bot searches LinkedIn and saves job listings."""
    if sync:
        # Run synchronously without Celery/Redis
        import uuid
        from backend.bot.linkedin_bot import scrape_jobs as do_scrape
        task_id = str(uuid.uuid4())[:8]
        try:
            do_scrape(task_id)
            return {"task_id": task_id, "status": "completed"}
        except Exception as e:
            logger.error("Sync scrape failed: %s", e)
            raise HTTPException(status_code=500, detail=str(e))
    else:
        task_id = start_scrape_task()
        return {"task_id": task_id, "status": "scraping"}


@router.post("/analyze")
def analyze_jobs(db: Session = Depends(get_db)):
    """Re-fetch descriptions and run match analysis on all jobs missing scores."""
    task_id = start_analyze_task()
    return {"task_id": task_id, "status": "analyzing"}


@router.post("/connect")
def connect_linkedin(db: Session = Depends(get_db)):
    """Open LinkedIn login in the bot's browser for manual authentication via noVNC."""
    from backend.services.browser_pool import BrowserSession
    import threading

    def _open_login():
        session = BrowserSession.get()
        page = session.page
        page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded")

    threading.Thread(target=_open_login, daemon=True).start()
    return {"status": "opening", "message": "LinkedIn login opened in bot browser. Use the viewer below to complete sign-in."}


@router.get("", response_model=list[ScrapedJobOut])
def list_jobs(
    status: Optional[JobStatus] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List scraped jobs, optionally filtered by status."""
    q = db.query(ScrapedJob)
    if status:
        q = q.filter(ScrapedJob.status == status)
    q = q.order_by(ScrapedJob.scraped_at.desc())
    q = q.offset((page - 1) * page_size).limit(page_size)
    return q.all()


@router.post("/{job_id}/apply")
def apply_to_job(job_id: int, db: Session = Depends(get_db)):
    """Start auto-apply for a specific scraped job."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.status == JobStatus.APPLIED:
        raise HTTPException(status_code=400, detail="Already applied to this job.")

    job.status = JobStatus.APPLYING
    db.commit()

    task_id = start_apply_task(job_id)
    return {"task_id": task_id, "job_id": job_id, "status": "applying"}


@router.get("/{job_id}/questions", response_model=list[PendingQuestionOut])
def get_pending_questions(job_id: int, db: Session = Depends(get_db)):
    """Get unanswered questions the bot is stuck on for a specific job."""
    questions = (
        db.query(PendingQuestion)
        .filter(PendingQuestion.job_id == job_id, PendingQuestion.answer.is_(None))
        .all()
    )
    return questions


@router.post("/questions/{question_id}/answer", response_model=PendingQuestionOut)
def answer_question(
    question_id: int,
    body: AnswerSubmit,
    db: Session = Depends(get_db),
):
    """Submit an answer to a pending question."""
    q = db.query(PendingQuestion).filter(PendingQuestion.id == question_id).first()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found.")
    q.answer = body.answer
    db.commit()
    db.refresh(q)

    # Check if all questions for this job are answered
    remaining = (
        db.query(PendingQuestion)
        .filter(PendingQuestion.job_id == q.job_id, PendingQuestion.answer.is_(None))
        .count()
    )
    if remaining == 0:
        # Update job status — ready to resume
        job = db.query(ScrapedJob).filter(ScrapedJob.id == q.job_id).first()
        if job:
            job.status = JobStatus.APPLYING
            db.commit()

    return q


@router.post("/{job_id}/resume-apply")
def resume_apply(job_id: int, db: Session = Depends(get_db)):
    """Resume applying to a job after all pending questions are answered."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    unanswered = (
        db.query(PendingQuestion)
        .filter(PendingQuestion.job_id == job_id, PendingQuestion.answer.is_(None))
        .count()
    )
    if unanswered > 0:
        raise HTTPException(status_code=400, detail=f"{unanswered} questions still unanswered.")

    task_id = start_apply_task(job_id)
    return {"task_id": task_id, "job_id": job_id, "status": "resuming"}


@router.get("/logs/{task_id}")
async def get_logs(task_id: str):
    """Stream real-time bot logs via Server-Sent Events (SSE)."""
    return StreamingResponse(
        stream_logs(task_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

# ============================================================
# Autopilot endpoints
# ============================================================

@router.post("/autopilot/start")
def autopilot_start(db: Session = Depends(get_db)):
    """Start the autopilot continuous auto-apply loop."""
    # Check if there's already a running autopilot
    existing = (
        db.query(AutopilotRun)
        .filter(AutopilotRun.status == "running")
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Autopilot already running (task {existing.task_id})",
        )

    task_id = start_autopilot_task()
    return {"task_id": task_id, "status": "running"}


@router.post("/autopilot/stop")
def autopilot_stop(db: Session = Depends(get_db)):
    """Stop the currently running autopilot task."""
    run = (
        db.query(AutopilotRun)
        .filter(AutopilotRun.status == "running")
        .first()
    )
    if not run:
        raise HTTPException(status_code=404, detail="No running autopilot found.")

    success = stop_autopilot_task(run.task_id)
    return {"task_id": run.task_id, "stopped": success}


@router.get("/autopilot/status")
def autopilot_status(db: Session = Depends(get_db)):
    """Return current autopilot stats: applied today, this week, and run info."""
    import datetime

    now = datetime.datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - datetime.timedelta(days=now.weekday())

    applied_today = (
        db.query(ApplicationRecord)
        .filter(ApplicationRecord.applied_at >= today_start)
        .count()
    )
    applied_this_week = (
        db.query(ApplicationRecord)
        .filter(ApplicationRecord.applied_at >= week_start)
        .count()
    )

    # Get latest autopilot run
    latest_run = (
        db.query(AutopilotRun)
        .order_by(AutopilotRun.started_at.desc())
        .first()
    )

    run_info = None
    if latest_run:
        run_info = {
            "task_id": latest_run.task_id,
            "status": latest_run.status,
            "started_at": latest_run.started_at.isoformat() if latest_run.started_at else None,
            "stopped_at": latest_run.stopped_at.isoformat() if latest_run.stopped_at else None,
            "total_applied": latest_run.total_applied,
            "total_skipped": latest_run.total_skipped,
            "total_failed": latest_run.total_failed,
            "total_waiting": latest_run.total_waiting,
        }

    return {
        "applied_today": applied_today,
        "applied_this_week": applied_this_week,
        "current_run": run_info,
    }


# ============================================================
# HR Outreach endpoints (Req 16.5, 16.7)
# ============================================================

@router.post("/{job_id}/connect")
def connect_hiring_managers(job_id: int, db: Session = Depends(get_db)):
    """Dispatch an HR connect task to send connection requests to hiring managers."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    task_id = start_connect_task(job_id)
    return {"task_id": task_id, "job_id": job_id, "status": "connecting"}


@router.get("/connections", response_model=list[ConnectionRequestOut])
def list_connections(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List sent connection requests with status."""
    q = (
        db.query(ConnectionRequest)
        .order_by(ConnectionRequest.sent_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return q.all()


# ============================================================
# Pause-before-submit endpoints (Req 19.2–19.5)
# ============================================================

@router.post("/approve-submit/{task_id}")
def approve_submit(task_id: str, db: Session = Depends(get_db)):
    """Approve a paused application — the bot will click Submit."""
    pq = (
        db.query(PendingQuestion)
        .filter(
            PendingQuestion.task_id == task_id,
            PendingQuestion.field_type == "approval",
            PendingQuestion.answer.is_(None),
        )
        .first()
    )
    if not pq:
        raise HTTPException(status_code=404, detail="No pending approval found for this task.")

    pq.answer = "approve"
    db.commit()
    return {"task_id": task_id, "action": "approved"}


@router.post("/cancel-submit/{task_id}")
def cancel_submit(task_id: str, db: Session = Depends(get_db)):
    """Cancel a paused application — the bot will discard the modal."""
    pq = (
        db.query(PendingQuestion)
        .filter(
            PendingQuestion.task_id == task_id,
            PendingQuestion.field_type == "approval",
            PendingQuestion.answer.is_(None),
        )
        .first()
    )
    if not pq:
        raise HTTPException(status_code=404, detail="No pending approval found for this task.")

    pq.answer = "cancel"
    db.commit()
    return {"task_id": task_id, "action": "cancelled"}
