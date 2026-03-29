"""
Celery task runner for bot execution.

Supports two task types:
    - scrape: search LinkedIn and save job listings
    - apply: apply to a specific job by ID
"""

import os
import json
import logging
import asyncio
from typing import AsyncGenerator

import redis

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
_redis = redis.from_url(REDIS_URL)


def _get_celery_app():
    """Lazy import to avoid circular deps."""
    from backend.worker import celery_app
    return celery_app


def start_scrape_task() -> str:
    """Dispatch the scrape task and return its task_id."""
    celery_app = _get_celery_app()
    task = celery_app.send_task("backend.worker.scrape_jobs")
    logger.info("Started scrape task: %s", task.id)
    return task.id


def start_apply_task(job_id: int) -> str:
    """Dispatch an apply task for a specific job."""
    celery_app = _get_celery_app()
    task = celery_app.send_task("backend.worker.apply_to_job", args=[job_id])
    logger.info("Started apply task for job %d: %s", job_id, task.id)
    return task.id


def start_analyze_task() -> str:
    """Dispatch an analyze task for jobs missing descriptions/scores."""
    celery_app = _get_celery_app()
    task = celery_app.send_task("backend.worker.analyze_jobs")
    logger.info("Started analyze task: %s", task.id)
    return task.id


def stop_bot_task(task_id: str) -> bool:
    """Revoke a running Celery task."""
    celery_app = _get_celery_app()
    try:
        celery_app.control.revoke(task_id, terminate=True)
        return True
    except Exception as e:
        logger.error("Failed to revoke task %s: %s", task_id, e)
        return False


def start_autopilot_task() -> str:
    """Dispatch the autopilot loop task and create an AutopilotRun record."""
    celery_app = _get_celery_app()
    task = celery_app.send_task("backend.worker.run_autopilot")
    task_id = task.id
    logger.info("Started autopilot task: %s", task_id)

    # Create AutopilotRun record
    from backend.db.database import SessionLocal
    from backend.db.models import AutopilotRun
    db = SessionLocal()
    try:
        run = AutopilotRun(task_id=task_id)
        db.add(run)
        db.commit()
    finally:
        db.close()

    return task_id


def stop_autopilot_task(task_id: str) -> bool:
    """Stop an autopilot task and finalize its AutopilotRun record."""
    # Disable the toggle so the loop exits gracefully
    from backend.db.database import SessionLocal
    from backend.db.models import UserSettings, AutopilotRun
    import datetime

    db = SessionLocal()
    try:
        settings = db.query(UserSettings).filter(UserSettings.id == 1).first()
        if settings:
            settings.autopilot_enabled = 0
            db.commit()

        run = db.query(AutopilotRun).filter(AutopilotRun.task_id == task_id).first()
        if run and run.status == "running":
            run.status = "stopped"
            run.stopped_at = datetime.datetime.utcnow()
            db.commit()
    finally:
        db.close()

    # Also revoke the Celery task as a fallback
    return stop_bot_task(task_id)


def publish_log(task_id: str, message: str, **extra) -> None:
    """Publish a log line to Redis for SSE streaming.

    Extra keyword arguments are merged into the JSON payload,
    e.g. ``publish_log(tid, "__WAITING__", pause_review={...})``.
    """
    payload: dict = {"message": message}
    if extra:
        payload.update(extra)
    _redis.publish(f"bot_logs:{task_id}", json.dumps(payload))


def start_connect_task(job_id: int) -> str:
    """Dispatch an HR connect task for a specific job.

    Sends connection requests to hiring managers at the company
    after the user has applied.
    Requirements: 16.5
    """
    celery_app = _get_celery_app()
    task = celery_app.send_task("backend.worker.connect_hiring_managers", args=[job_id])
    logger.info("Started connect task for job %d: %s", job_id, task.id)
    return task.id


async def stream_logs(task_id: str) -> AsyncGenerator[str, None]:
    """Async generator that yields SSE-formatted log lines from Redis pub/sub."""
    pubsub = _redis.pubsub()
    channel = f"bot_logs:{task_id}"
    pubsub.subscribe(channel)

    try:
        while True:
            message = pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message and message["type"] == "message":
                data = message["data"]
                if isinstance(data, bytes):
                    data = data.decode("utf-8")
                yield f"data: {data}\n\n"

                try:
                    parsed = json.loads(data)
                    if parsed.get("message") in ("__DONE__", "__ERROR__"):
                        break
                except json.JSONDecodeError:
                    pass
            else:
                await asyncio.sleep(0.5)
    finally:
        pubsub.unsubscribe(channel)
        pubsub.close()
