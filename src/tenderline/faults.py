"""Test-only fault injection used by the crash-recovery tests.

When TENDERLINE_FAULT=<point> is set, the process terminates abruptly (no cleanup, like `kill -9`) the first
time execution reaches that point. It is inert unless the variable is set, which only the workflow tests do.
"""

from __future__ import annotations

import os


def maybe_crash(point: str) -> None:
    if os.environ.get("TENDERLINE_FAULT") == point:
        os._exit(86)
