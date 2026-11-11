"""Per-organisation fixed-window rate limiter (in-process; one API process per VM, see docs/adr)."""

from __future__ import annotations

import threading
import time
import uuid

from tenderline.config import get_settings
from tenderline.errors import ApiError

_lock = threading.Lock()
_windows: dict[uuid.UUID, tuple[int, int]] = {}


def check(org_id: uuid.UUID) -> None:
    limit = get_settings().rate_limit_per_minute
    window = int(time.time() // 60)
    with _lock:
        w, count = _windows.get(org_id, (window, 0))
        if w != window:
            w, count = window, 0
        count += 1
        _windows[org_id] = (w, count)
    if count > limit:
        retry = 60 - int(time.time() % 60)
        raise ApiError(
            429,
            "rate_limited",
            "Organisation rate limit exceeded",
            {"limit_per_minute": limit},
            headers={"Retry-After": str(retry)},
        )


def reset() -> None:
    with _lock:
        _windows.clear()
