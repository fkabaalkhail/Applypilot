import json
import time

import psutil  # type: ignore
import redis.asyncio as redis
from redis.backoff import ExponentialBackoff
from redis.exceptions import BusyLoadingError, ConnectionError, TimeoutError
from redis.retry import Retry
from loguru import logger

from config import config

# Module-level singleton — populated during lifespan startup.
_client: redis.Redis | None = None


def _make_client() -> redis.Redis:
    """Build a Redis client with retry and health-check settings."""
    retry = Retry(ExponentialBackoff(cap=5, base=0.5), retries=3)
    return redis.from_url(
        config.REDIS_URL,
        decode_responses=False,
        health_check_interval=10,
        socket_connect_timeout=5,
        socket_timeout=5,
        retry=retry,
        retry_on_error=[BusyLoadingError, ConnectionError, TimeoutError],
    )


async def connect() -> None:
    """Create and verify the Redis connection. Called once from the FastAPI lifespan."""
    global _client
    _client = _make_client()
    await _client.ping()  # type: ignore[misc]
    logger.info("Redis connected: {}", config.REDIS_URL)


async def close() -> None:
    """Tear down the Redis connection. Called once from the FastAPI lifespan."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
        logger.info("Redis connection closed")


async def reconnect() -> None:
    """Tear down and re-create the Redis connection (recovery from broken pool)."""
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:
            pass  # old connection is already broken
    _client = _make_client()
    await _client.ping()  # type: ignore[misc]
    logger.info("Redis reconnected: {}", config.REDIS_URL)


def _require_client() -> redis.Redis:
    if _client is None:
        raise RuntimeError(
            "Redis client is not initialised. "
            "Ensure connect() was awaited before handling requests."
        )
    return _client


async def publish_capacity(session_count: int) -> None:
    """
    Compute and publish this pod's health metrics to the pod_capacity hash.

    Schema (matches bot_runner's reader):
      Key:   pod_capacity
      Field: config.pod_name
      Value: JSON {
               "available": bool,
               "load_score": float,   # 0.0–1.0, lower is better
               "sessions": int,
               "max_sessions": int,
               "cpu_pct": float,
               "mem_pct": float,
               "timestamp": float
             }

    Load score (weighted, normalised 0.0–1.0):
      0.3 * cpu_pct + 0.3 * mem_pct + 0.4 * session_pct
    Session count is weighted highest — most predictable signal for voice bots.
    """
    client = _require_client()

    cpu_pct = psutil.cpu_percent(interval=None)
    mem_pct = psutil.virtual_memory().percent
    session_pct = (session_count / config.MAX_SESSIONS) * \
        100 if config.MAX_SESSIONS > 0 else 0

    available = (
        session_count < config.MAX_SESSIONS
        and cpu_pct < config.CPU_THRESHOLD
        and mem_pct < config.MEM_THRESHOLD
    )

    load_score = round(
        (0.3 * cpu_pct + 0.3 * mem_pct + 0.4 * session_pct) / 100, 4)

    payload = json.dumps({
        "available": available,
        "load_score": load_score,
        "sessions": session_count,
        "max_sessions": config.MAX_SESSIONS,
        "cpu_pct": round(cpu_pct, 1),
        "mem_pct": round(mem_pct, 1),
        "timestamp": time.time(),
    })

    await client.hset(
        "pod_capacity", config.pod_name, payload
    )  # type: ignore[misc]


async def mark_unavailable(session_count: int) -> None:
    """Mark this pod as unavailable during shutdown (before draining sessions)."""
    client = _require_client()
    await client.hset("pod_capacity", config.pod_name, json.dumps({
        "available": False,
        "load_score": 1.0,
        "sessions": session_count,
        "max_sessions": config.MAX_SESSIONS,
        "cpu_pct": 100,
        "mem_pct": 100,
        "timestamp": time.time(),
    }))  # type: ignore[misc]


async def deregister() -> None:
    """Remove this pod from the pod_capacity hash."""
    client = _require_client()
    await client.hdel("pod_capacity", config.pod_name)  # type: ignore[misc]
