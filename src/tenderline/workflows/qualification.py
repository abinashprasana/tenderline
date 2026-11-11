"""LLM qualification of matches, and the backfill that runs when a saved search is created or changed."""

from __future__ import annotations

import uuid
from typing import Any

from dbos import DBOS

from tenderline.agent.qualify import AgentUnavailable, qualify_match
from tenderline.config import get_settings
from tenderline.matching import backfill_org
from tenderline.observability import continue_trace, record_workflow_failure
from tenderline.workflows.queues import QUEUE_QUALIFY


@DBOS.step(
    retries_allowed=True,
    max_attempts=3,
    interval_seconds=5,
    backoff_rate=2.0,
    should_retry=lambda error: isinstance(error, AgentUnavailable),
)
def qualify_step(org_id: str, match_id: str, traceparent: str | None = None, link_only: bool = False) -> dict[str, Any]:
    attributes = {"tenderline.org_id": org_id, "tenderline.match_id": match_id}
    with continue_trace(traceparent, "queue.qualify_match", attributes, link_only=link_only):
        return qualify_match(uuid.UUID(org_id), uuid.UUID(match_id))


@DBOS.workflow()
def qualify_workflow(
    org_id: str, match_id: str, traceparent: str | None = None, link_only: bool = False
) -> dict[str, Any]:
    """Ask the agent about one match. `link_only` marks fan-out work: the span starts its own trace and links
    back to the request that caused it, instead of joining that request's trace."""
    try:
        return qualify_step(org_id, match_id, traceparent, link_only)
    except Exception:
        record_workflow_failure("qualify_workflow")
        raise


@DBOS.step()
def find_backfill_matches(org_id: str, search_id: str, traceparent: str | None = None) -> list[str]:
    with continue_trace(traceparent, "queue.backfill_matches", {"tenderline.org_id": org_id}):
        return [str(match_id) for match_id in backfill_org(uuid.UUID(org_id), uuid.UUID(search_id))]


@DBOS.workflow()
def backfill_workflow(org_id: str, search_id: str, traceparent: str | None = None) -> dict[str, Any]:
    """Match a new or changed saved search against notices already stored, then qualify the newest matches.

    Only `BACKFILL_QUALIFY_LIMIT` matches are qualified automatically, so one broad search cannot flood the LLM
    queue. The rest stay visible as matches and can be qualified on request.
    """
    match_ids = find_backfill_matches(org_id, search_id, traceparent)
    to_qualify = match_ids[: get_settings().backfill_qualify_limit]
    for match_id in to_qualify:
        DBOS.enqueue_workflow(QUEUE_QUALIFY, qualify_workflow, org_id, match_id, traceparent, True)
    return {
        "search_id": search_id,
        "new_or_refreshed_matches": len(match_ids),
        "qualification_enqueued": len(to_qualify),
    }
