"""
In-memory rate limiter for authentication endpoints.

Uses a sliding window approach with per-IP tracking.
For production at scale, replace with Redis-based implementation.
"""

import time
import threading
from collections import defaultdict
from typing import Optional

from fastapi import Request, HTTPException


class RateLimiter:
    """Sliding window rate limiter with per-IP tracking."""

    def __init__(self):
        # {key: [timestamp1, timestamp2, ...]}
        self._requests: dict[str, list[float]] = defaultdict(list)
        self._lock = threading.Lock()

    def _get_client_ip(self, request: Request) -> str:
        """Extract client IP, respecting X-Forwarded-For for proxied requests."""
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        if request.client:
            return request.client.host
        return "unknown"

    def _cleanup_old_entries(self, key: str, window_seconds: int) -> None:
        """Remove entries older than the window."""
        now = time.time()
        cutoff = now - window_seconds
        self._requests[key] = [t for t in self._requests[key] if t > cutoff]

    def check_rate_limit(
        self,
        request: Request,
        endpoint: str,
        max_requests: int = 5,
        window_seconds: int = 60,
    ) -> Optional[int]:
        """Check if the request is within rate limits.

        Returns None if allowed, or retry_after seconds if rate limited.
        """
        ip = self._get_client_ip(request)
        key = f"{endpoint}:{ip}"

        with self._lock:
            self._cleanup_old_entries(key, window_seconds)

            if len(self._requests[key]) >= max_requests:
                # Calculate retry_after
                oldest = self._requests[key][0]
                retry_after = int(window_seconds - (time.time() - oldest)) + 1
                return max(retry_after, 1)

            self._requests[key].append(time.time())
            return None

    def enforce(
        self,
        request: Request,
        endpoint: str,
        max_requests: int = 5,
        window_seconds: int = 60,
    ) -> None:
        """Enforce rate limit, raising HTTPException if exceeded."""
        retry_after = self.check_rate_limit(request, endpoint, max_requests, window_seconds)
        if retry_after is not None:
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Please try again later.",
                headers={"Retry-After": str(retry_after)},
            )


# Singleton instance
rate_limiter = RateLimiter()
