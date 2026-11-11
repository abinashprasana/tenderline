"""Daily TED ingestion.

Workflow bodies only branch on step results. Anything that touches the database, the clock or the network is
a step, which is what lets DBOS replay a workflow after a crash.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from functools import lru_cache
from typing import Any

from dbos import DBOS

from tenderline.config import get_settings
from tenderline.notices import finish_run, ingest_batch, last_cursor, last_success_date, start_run
from tenderline.observability import record_ingested, record_workflow_failure, tracer
from tenderline.ted.client import TedClient, TedExpiredToken
from tenderline.ted.query import build_ingest_query
from tenderline.workflows.notice_events import process_notice_workflow
from tenderline.workflows.queues import QUEUE_ENRICH


@lru_cache
def _ted_client() -> TedClient:
    settings = get_settings()
    return TedClient(
        settings.ted_base_url,
        max_requests_per_minute=settings.ted_max_requests_per_minute,
        page_size=settings.ted_page_size,
    )


def reset_ted_client() -> None:
    _ted_client.cache_clear()


@DBOS.step(retries_allowed=True, max_attempts=4, interval_seconds=5, backoff_rate=2.0)
def open_or_resume_run(since_iso: str | None) -> dict[str, Any]:
    """Pick up the unfinished run's cursor if there is one, otherwise open a new run."""
    settings = get_settings()
    unfinished = last_cursor("ted")
    if unfinished and unfinished["cursor"] and unfinished["cursor"].get("token"):
        cursor = unfinished["cursor"]
        return {
            "run_id": unfinished["run_id"],
            "token": cursor["token"],
            "page": int(cursor.get("page", 0)),
            "query": cursor["query"],
            "resumed": True,
        }
    if since_iso:
        since = date.fromisoformat(since_iso)
    else:
        # Re-read a few days before the last success: TED publishes late and the storage layer skips duplicates.
        since = (last_success_date("ted") or date.today()) - timedelta(days=settings.ted_lookback_days)  # noqa: DTZ011
    query = build_ingest_query(settings.ted_country, since, settings.extra_cpv_prefixes)
    run_id = start_run("ted", since, DBOS.workflow_id)
    return {"run_id": str(run_id), "token": None, "page": 0, "query": query, "resumed": False}


# No DBOS retries here: the TED client already retries with backoff, and a failed run resumes from its cursor.
@DBOS.step()
def ingest_page(run_id: str, query: str, token: str | None, page_no: int) -> dict[str, Any]:
    """Fetch one page and store it. The cursor moves in the same transaction as the data."""
    try:
        with tracer().start_as_current_span("ted.search_page", attributes={"ted.page": page_no}):
            page = _ted_client().search_page(query, token=token)
    except TedExpiredToken:
        return {"expired": True, "events": [], "next_token": None, "count": 0}
    events = ingest_batch(uuid.UUID(run_id), page.notices, page.next_token, page_no, query)
    record_ingested(sum(1 for event in events if event["action"] == "new"), "ted")
    return {"expired": False, "events": events, "next_token": page.next_token, "count": len(page.notices)}


@DBOS.step()
def close_run(run_id: str, status: str, error: str | None) -> None:
    finish_run(uuid.UUID(run_id), status, error)


@DBOS.workflow()
def ingest_ted_workflow(since_iso: str | None = None) -> dict[str, Any]:
    """Ingest TED notices page by page and queue each new or changed notice for matching.

    Safe to re-run: stored notices are skipped. A run that stops at the page limit stays open and the next run
    continues from its cursor.
    """
    settings = get_settings()
    run = open_or_resume_run(since_iso)
    run_id, token, page_no, query = run["run_id"], run["token"], run["page"], run["query"]
    pages = events_total = token_restarts = 0
    finished = False
    try:
        while pages < settings.ingest_max_pages:
            page = ingest_page(run_id, query, token, page_no + 1)
            if page["expired"]:
                # TED's point-in-time snapshot expired. Start the window again; stored notices are skipped.
                token_restarts += 1
                if token_restarts > 1:
                    raise RuntimeError("TED iteration token expired twice in one run")
                token, page_no = None, 0
                continue
            if not page["count"]:  # an empty page is how TED says there are no more results
                finished = True
                break
            for event in page["events"]:
                DBOS.enqueue_workflow(QUEUE_ENRICH, process_notice_workflow, event)
            events_total += len(page["events"])
            pages += 1
            page_no += 1
            token = page["next_token"]
            if not token:
                finished = True
                break
        if finished:
            close_run(run_id, "ok", None)
    except Exception as exc:
        close_run(run_id, "error", f"{type(exc).__name__}: {exc}"[:1000])
        record_workflow_failure("ingest_ted_workflow")
        raise
    return {"run_id": run_id, "pages": pages, "events": events_total, "complete": finished, "resumed": run["resumed"]}


@DBOS.workflow()
def scheduled_ingestion(scheduled_time: datetime, context: Any) -> None:
    ingest_ted_workflow(None)
