import asyncio
import logging
import sys
import time
from contextlib import asynccontextmanager

import psutil  # type: ignore
import redis_client as rc
import sentry_sdk
from config import config
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import BaseModel
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.logging import LoggingIntegration
from utils.agent_client import fetch_agent


def setup_sentry() -> None:
    if not config.is_live or not config.SENTRY_DSN:
        logger.info(
            "Skipping Sentry initialization in {} environment", config.ENV_STATE
        )
        return

    sentry_sdk.init(
        dsn=config.SENTRY_DSN,
        environment=config.ENV_STATE,
        release=config.APP_VERSION,
        traces_sample_rate=0.2,
        profiles_sample_rate=0.1,
        send_default_pii=False,
        integrations=[
            FastApiIntegration(transaction_style="endpoint"),
            LoggingIntegration(
                level=logging.WARNING,
                event_level=logging.ERROR,
            ),
        ],
    )

    logger.info(
        "Sentry initialized | environment={} | release={}",
        config.ENV_STATE,
        config.APP_VERSION
    )


setup_sentry()

# Active sessions: session_id -> subprocess Process
active_sessions: dict[str, asyncio.subprocess.Process] = {}

# Monitor tasks that wait for subprocess exit and clean up
_monitor_tasks: dict[str, asyncio.Task] = {}

# Process start times: session_id -> monotonic timestamp when subprocess was spawned
_session_start_times: dict[str, float] = {}

capacity_task: asyncio.Task | None = None


# ------------ Request schema ------------ #

class StartSessionRequest(BaseModel):
    session_id: str
    room_url: str
    token: str


class StartLiveKitSessionRequest(BaseModel):
    session_id: str
    room_name: str
    token: str
    livekit_url: str

# ------------ Lifespan ------------ #


@asynccontextmanager
async def lifespan(app: FastAPI):
    global capacity_task

    await rc.connect()
    await rc.publish_capacity(len(active_sessions))
    capacity_task = asyncio.create_task(capacity_loop())
    logger.info(f"{config.pod_name} registered in Redis")

    yield

    capacity_task.cancel()
    try:
        await rc.mark_unavailable(len(active_sessions))
    except Exception as e:
        logger.error(f"Failed to mark pod unavailable in Redis: {e}")

    logger.info(
        f"{config.pod_name} marked unavailable, draining {len(active_sessions)} sessions...")

    # Graceful drain: SIGTERM all subprocesses, wait, then SIGKILL stragglers
    # snapshot to avoid dict mutation issues
    procs = list(active_sessions.items())
    for session_id, proc in procs:
        if proc.returncode is None:  # still running
            logger.info("[{}] sending SIGTERM to subprocess pid={}",
                        session_id, proc.pid)
            try:
                proc.terminate()
            except ProcessLookupError:
                pass

    # Wait for all subprocesses to exit (or timeout)
    if procs:
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    *(proc.wait()
                      for _, proc in procs if proc.returncode is None),
                    return_exceptions=True,
                ),
                timeout=config.MAX_SESSION_TIME,
            )
        except asyncio.TimeoutError:
            logger.warning(
                f"{config.pod_name} drain timeout, killing {len(active_sessions)} remaining subprocesses")
            for session_id, proc in procs:
                if proc.returncode is None:
                    logger.warning(
                        "[{}] sending SIGKILL to pid={}", session_id, proc.pid)
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass

    # Cancel all monitor tasks
    for task in list(_monitor_tasks.values()):
        task.cancel()

    try:
        await rc.deregister()
    except Exception as e:
        logger.error(f"Failed to deregister from Redis: {e}")

    await rc.close()
    logger.info(f"{config.pod_name} deregistered from Redis")


# ------------ FastAPI ------------ #

app = FastAPI(lifespan=lifespan)


# ------------ Auth ------------ #

async def verify_internal_key(
    x_api_key: str = Header(..., alias="X-Api-Key"),
) -> None:
    if x_api_key != config.BOT_WORKER_API_KEY:
        raise HTTPException(
            status_code=401, detail="Unauthorized"
        )


# ------------ Capacity loop ------------ #

_MAX_CONSECUTIVE_FAILURES = 6  # 6 × 5s = ~30s before reconnect attempt


async def capacity_loop():
    consecutive_failures = 0
    while True:
        session_ids = list(active_sessions.keys())
        logger.debug(
            "[capacity_loop] active_sessions={} keys={}",
            len(active_sessions), session_ids,
        )
        try:
            await rc.publish_capacity(len(active_sessions))
            consecutive_failures = 0
        except Exception as e:
            consecutive_failures += 1
            logger.error(
                f"Failed to publish capacity (consecutive={consecutive_failures}): {e}"
            )
            if consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
                logger.warning("Capacity publish failed {} times, reconnecting Redis",
                               consecutive_failures)
                try:
                    await rc.reconnect()
                    consecutive_failures = 0
                except Exception as re_err:
                    logger.error(f"Redis reconnect failed: {re_err}")

        # Liveness audit: force-kill any process that exceeded MAX_SESSION_TIME
        now = time.monotonic()
        for session_id in list(_session_start_times.keys()):
            elapsed = now - _session_start_times.get(session_id, now)
            if elapsed <= config.MAX_SESSION_TIME:
                continue

            proc = active_sessions.get(session_id)
            if proc is None:
                # Already cleaned up by monitor, just remove stale start time
                _session_start_times.pop(session_id, None)
                continue

            logger.warning(
                "[{}] liveness audit: process running for {:.0f}s (limit {}s) — force killing pid={}",
                session_id, elapsed, config.MAX_SESSION_TIME, proc.pid,
            )

            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass

            # Capture monitor task ref before mutating dicts
            monitor_task = _monitor_tasks.get(session_id)

            active_sessions.pop(session_id, None)
            _monitor_tasks.pop(session_id, None)
            _session_start_times.pop(session_id, None)

            if monitor_task and not monitor_task.done():
                monitor_task.cancel()

            try:
                await rc.publish_capacity(len(active_sessions))
                logger.info(
                    "[{}] liveness audit: capacity updated after forced cleanup | active={}",
                    session_id, len(active_sessions),
                )
            except Exception as e:
                logger.error(
                    "[{}] liveness audit: failed to publish capacity after cleanup: {}",
                    session_id, e,
                )

        await asyncio.sleep(10)


# ------------ Subprocess management ------------ #


async def _stream_subprocess_output(
    stream: asyncio.StreamReader, session_id: str, level: str,
) -> None:
    """Read lines from a subprocess stream and log them."""
    while True:
        line = await stream.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace").rstrip()
        if level == "stderr":
            logger.warning("[{}] {}", session_id, text)
        else:
            logger.info("[{}] {}", session_id, text)


async def _monitor_subprocess(session_id: str, proc: asyncio.subprocess.Process) -> None:
    """Wait for a subprocess to exit and clean up."""
    try:
        # Stream stdout/stderr in parallel
        tasks = []
        if proc.stdout:
            tasks.append(asyncio.create_task(
                _stream_subprocess_output(proc.stdout, session_id, "stdout")))
        if proc.stderr:
            tasks.append(asyncio.create_task(
                _stream_subprocess_output(proc.stderr, session_id, "stderr")))

        # Wait for subprocess to exit (hard limit = MAX_SESSION_TIME)
        try:
            returncode = await asyncio.wait_for(
                proc.wait(),
                timeout=config.MAX_SESSION_TIME,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "[{}] subprocess exceeded timeout ({}s) — terminating pid={}",
                session_id, config.MAX_SESSION_TIME, proc.pid,
            )
            try:
                proc.terminate()
            except ProcessLookupError:
                pass

            # Give it 5s to exit after SIGTERM, then SIGKILL
            try:
                returncode = await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                logger.warning("[{}] subprocess did not exit after SIGTERM — killing pid={}",
                               session_id, proc.pid)
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                returncode = await proc.wait()

        # Wait for log streaming to finish
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        if returncode == 0:
            logger.info("[{}] subprocess exited normally", session_id)
        else:
            logger.error("[{}] subprocess exited with code {}",
                         session_id, returncode)

    except asyncio.CancelledError:
        logger.info("[{}] monitor task cancelled", session_id)
    except Exception:
        logger.exception(
            "[{}] unexpected error in subprocess monitor", session_id)
    finally:
        active_sessions.pop(session_id, None)
        _monitor_tasks.pop(session_id, None)
        _session_start_times.pop(session_id, None)
        for attempt in range(3):
            try:
                await rc.publish_capacity(len(active_sessions))
                logger.info("[{}] capacity published after cleanup | active={}",
                            session_id, len(active_sessions))
                break
            except Exception as e:
                logger.error(
                    "[{}] publish_capacity failed (attempt {}/3): {}", session_id, attempt + 1, e)
                if attempt < 2:
                    await asyncio.sleep(1)


async def _spawn_session_subprocess(
    session_id: str,
    room_name: str,
    token: str,
    livekit_url: str,
    agent_json: str,
) -> asyncio.subprocess.Process:
    """Spawn a subprocess running bot.session_runner for a single session."""
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "bot.session_runner",
        "--session-id", session_id,
        "--room-name", room_name,
        "--token", token,
        "--livekit-url", livekit_url,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # Send agent config via stdin and close
    assert proc.stdin is not None
    proc.stdin.write(agent_json.encode("utf-8"))
    await proc.stdin.drain()
    proc.stdin.close()
    await proc.stdin.wait_closed()

    return proc


# ------------ Endpoints ------------ #

@app.get("/health")
async def health():
    return {"status": "ok", "pod": config.pod_name}


@app.get("/capacity")
async def capacity():
    cpu_pct = psutil.cpu_percent(interval=None)
    mem_pct = psutil.virtual_memory().percent
    session_count = len(active_sessions)
    session_pct = (session_count / config.MAX_SESSIONS) * \
        100 if config.MAX_SESSIONS > 0 else 0
    load_score = round(
        (0.3 * cpu_pct + 0.3 * mem_pct + 0.4 * session_pct) / 100, 4)

    return {
        "pod": config.pod_name,
        "active": session_count,
        "max": config.MAX_SESSIONS,
        "available": config.MAX_SESSIONS - session_count,
        "cpu_pct": round(cpu_pct, 1),
        "mem_pct": round(mem_pct, 1),
        "load_score": load_score,
    }


@app.post(
    "/start-session/{agent_id}",
    dependencies=[Depends(verify_internal_key)],
)
async def start_session_livekit(agent_id: str, body: StartLiveKitSessionRequest) -> JSONResponse:
    cpu_pct = psutil.cpu_percent(interval=None)
    mem_pct = psutil.virtual_memory().percent

    if len(active_sessions) >= config.MAX_SESSIONS or cpu_pct >= config.CPU_THRESHOLD or mem_pct >= config.MEM_THRESHOLD:
        raise HTTPException(status_code=503, detail="Pod at capacity")

    if body.session_id in active_sessions:
        raise HTTPException(status_code=409, detail="Session already active")

    agent = await fetch_agent(agent_id)
    agent_json = agent.model_dump_json()

    proc = await _spawn_session_subprocess(
        session_id=body.session_id,
        room_name=body.room_name,
        token=body.token,
        livekit_url=body.livekit_url,
        agent_json=agent_json,
    )

    active_sessions[body.session_id] = proc
    _session_start_times[body.session_id] = time.monotonic()
    _monitor_tasks[body.session_id] = asyncio.create_task(
        _monitor_subprocess(body.session_id, proc)
    )

    await rc.publish_capacity(len(active_sessions))

    logger.info(
        "[{}] subprocess spawned | pid={} count={}/{} keys={}",
        body.session_id, proc.pid, len(active_sessions), config.MAX_SESSIONS,
        list(active_sessions.keys()),
    )

    return JSONResponse({"status": "started", "session_id": body.session_id})
