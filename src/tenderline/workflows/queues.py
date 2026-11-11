"""Queue names and the signal topic shared by the workflow modules."""

from __future__ import annotations

import logging

from dbos import DBOS

log = logging.getLogger(__name__)

QUEUE_ENRICH = "enrich"  # notice events and saved-search backfills
QUEUE_QUALIFY = "qualify"  # LLM qualification
QUEUE_INGEST = "ingest"  # one TED ingestion at a time
EVENTS_TOPIC = "events"  # signals sent to an opportunity workflow


def wake_opportunity_workflow(workflow_id: str, reason: str, **fields: str) -> None:
    """Tell an opportunity workflow to re-read its state now instead of at its next timer.

    Best effort on purpose. The workflow may not exist yet or may have finished, and it re-reads the database
    on every wake-up anyway, so a lost signal only delays it until its next timer.
    """
    try:
        DBOS.send(workflow_id, {"type": reason, **fields}, EVENTS_TOPIC)
    except Exception:  # noqa: BLE001 - e.g. DBOSNonExistentWorkflowError
        log.info("no opportunity workflow to wake: %s", workflow_id)
