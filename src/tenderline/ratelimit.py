"""Fixed-window rate limiter, counted per organisation (or per user on shared-data endpoints).

It lives in process memory, which is correct while the API runs as one process (see docs/adr/0004). Running
several API processes would need a shared counter instead.
"""

from __future__ import annotations

import threading
import time
import uuid

from tenderline.config import get_settings
from tenderline.errors import ApiError

_lock = threading.Lock()
_request_counts: dict[uuid.UUID, tuple[int, int]] = {}  # subject -> (minute window, requests in it)
_PRUNE_ABOVE = 10_000


def _prune(current_window: int) -> None:
    """Forget subjects whose last request was in an earlier minute, so the table cannot grow without limit."""
    stale = [subject for subject, (window, _) in _request_counts.items() if window != current_window]
    for subject in stale:
        del _request_counts[subject]


def check(subject_id: uuid.UUID) -> None:
    """Count one request for this organisation or user; raise 429 once the minute's allowance is used up."""
    limit = get_settings().rate_limit_per_minute
    current_window = int(time.time() // 60)
    with _lock:
        window, count = _request_counts.get(subject_id, (current_window, 0))
        if window != current_window:
            count = 0
        count += 1
        _request_counts[subject_id] = (current_window, count)
        if len(_request_counts) > _PRUNE_ABOVE:
            _prune(current_window)
    if count > limit:
        seconds_left = 60 - int(time.time() % 60)
        raise ApiError(
            429,
            "rate_limited",
            "Rate limit exceeded",
            {"limit_per_minute": limit},
            headers={"Retry-After": str(seconds_left)},
        )


def tracked_subjects() -> int:
    with _lock:
        return len(_request_counts)


def reset() -> None:
    with _lock:
        _request_counts.clear()
