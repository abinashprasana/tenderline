"""TED Search API v3 client (POST /v3/notices/search, iteration / scroll mode).

Verified against https://ted.europa.eu/api/documentation (request: query, fields, limit, paginationMode,
iterationNextToken; response: notices, totalNoticeCount, iterationNextToken, timedOut) and the fair usage
policy (700 requests / minute). This client deliberately stays far below that: it paces requests, honours
Retry-After, and backs off exponentially with full jitter on 429 / 5xx / network errors.
"""

from __future__ import annotations

import email.utils
import logging
import random
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)

SEARCH_PATH = "/v3/notices/search"

# Fields requested for every notice. Names are the TED search field names (see TED field list).
SEARCH_FIELDS = [
    "publication-number",
    "notice-identifier",
    "procedure-identifier",
    "notice-type",
    "notice-version",
    "notice-title",
    "buyer-name",
    "buyer-country",
    "publication-date",
    "deadline-receipt-tender-date-lot",
    "classification-cpv",
    "estimated-value-lot",
    "estimated-value-cur-lot",
    "description-lot",
    "winner-name",
    "total-value",
    "winner-selection-status",
]


class TedError(Exception):
    """Non-retryable TED failure (4xx other than 429) or retries exhausted."""


class TedExpiredToken(TedError):
    """The iteration token is no longer valid; the caller must restart the window."""


@dataclass(frozen=True)
class TedPage:
    notices: list[dict[str, Any]]
    next_token: str | None
    total: int | None


def parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    """Retry-After is either delta-seconds or an HTTP date."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        dt = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, dt.timestamp() - (now if now is not None else time.time()))


class TedClient:
    def __init__(
        self,
        base_url: str = "https://api.ted.europa.eu",
        *,
        max_requests_per_minute: int = 60,
        page_size: int = 100,
        timeout: float = 60.0,
        max_attempts: int = 6,
        backoff_base: float = 2.0,
        backoff_cap: float = 120.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        rand: Callable[[], float] = random.random,
    ) -> None:
        if not 1 <= max_requests_per_minute <= 600:
            raise ValueError("max_requests_per_minute must stay well below TED's 700/min limit")
        if not 1 <= page_size <= 250:
            raise ValueError("TED allows at most 250 notices per page")
        self.page_size = page_size
        self._interval = 60.0 / max_requests_per_minute
        self._last = float("-inf")
        self._max_attempts, self._base, self._cap = max_attempts, backoff_base, backoff_cap
        self._sleep, self._mono, self._rand = sleep, monotonic, rand
        self._http = httpx.Client(base_url=base_url, timeout=timeout, transport=transport)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> TedClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -------------------------------------------------------------- pacing / retry
    def _pace(self) -> None:
        wait = self._last + self._interval - self._mono()
        if wait > 0:
            self._sleep(wait)
        self._last = self._mono()

    def backoff_delay(self, attempt: int) -> float:
        """Exponential backoff with full jitter: uniform(0, min(cap, base * 2**attempt))."""
        return float(self._rand() * min(self._cap, self._base * (2**attempt)))

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        last_error = "unknown"
        for attempt in range(self._max_attempts):
            self._pace()
            try:
                resp = self._http.post(SEARCH_PATH, json=body)
            except httpx.TransportError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                self._sleep(self.backoff_delay(attempt))
                continue
            if resp.status_code == 200:
                data: dict[str, Any] = resp.json()
                return data
            if resp.status_code == 429 or resp.status_code >= 500:
                retry_after = parse_retry_after(resp.headers.get("Retry-After"))
                delay = retry_after if retry_after is not None else self.backoff_delay(attempt)
                last_error = f"HTTP {resp.status_code}"
                log.warning("TED %s, retrying in %.1fs (attempt %d)", resp.status_code, delay, attempt + 1)
                self._sleep(delay)
                continue
            text = resp.text[:500]
            if "ExpiredIterationToken" in text or "InvalidIterationToken" in text:
                raise TedExpiredToken(text)
            raise TedError(f"TED rejected the request: HTTP {resp.status_code}: {text}")
        raise TedError(f"TED retries exhausted ({last_error})")

    # -------------------------------------------------------------- API
    def search_page(self, query: str, *, fields: list[str] | None = None, token: str | None = None) -> TedPage:
        body: dict[str, Any] = {
            "query": query,
            "fields": fields or SEARCH_FIELDS,
            "limit": self.page_size,
            "paginationMode": "ITERATION",
        }
        if token:
            body["iterationNextToken"] = token
        data = self._post(body)
        return TedPage(
            notices=list(data.get("notices") or []),
            next_token=data.get("iterationNextToken"),
            total=data.get("totalNoticeCount"),
        )

    def iterate(
        self,
        query: str,
        *,
        fields: list[str] | None = None,
        token: str | None = None,
        max_pages: int | None = None,
    ) -> Iterator[TedPage]:
        """Yield pages until TED returns no more notices (or max_pages is reached)."""
        pages = 0
        while True:
            page = self.search_page(query, fields=fields, token=token)
            if not page.notices:
                return
            yield page
            pages += 1
            token = page.next_token
            if not token or (max_pages is not None and pages >= max_pages):
                return
