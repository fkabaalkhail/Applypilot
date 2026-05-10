"""
Job deduplication utilities.

Provides functions to deduplicate job listings by URL before storage.
"""

from typing import Protocol, TypeVar, Sequence


class HasUrl(Protocol):
    """Protocol for objects that have a url attribute."""

    url: str


T = TypeVar("T", bound=HasUrl)


def deduplicate_jobs_by_url(jobs: Sequence[T]) -> list[T]:
    """Deduplicate a list of jobs by URL, preserving first occurrence order.

    For any list of jobs (possibly containing duplicate URLs), after deduplication:
    - No two jobs in the output share the same URL
    - Every unique URL from the input appears exactly once
    - The first occurrence of each URL is preserved

    Requirements: 1.3
    """
    seen_urls: set[str] = set()
    unique_jobs: list[T] = []

    for job in jobs:
        if job.url not in seen_urls:
            seen_urls.add(job.url)
            unique_jobs.append(job)

    return unique_jobs
