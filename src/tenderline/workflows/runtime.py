"""Starting and stopping DBOS, and the few functions the API uses to start or signal workflows."""

from __future__ import annotations

import logging
import os
import threading
import uuid
from typing import Any

from dbos import DBOS, DBOSConfig, SetWorkflowID

from tenderline import __version__
from tenderline.config import get_settings
from tenderline.errors import ApiError
from tenderline.observability import current_traceparent
from tenderline.workflows.queues import QUEUE_ENRICH, QUEUE_INGEST, QUEUE_QUALIFY, wake_opportunity_workflow

log = logging.getLogger(__name__)

_lock = threading.Lock()
_started = False


def application_version() -> str:
    """DBOS resumes only the workflows started by this version, so it must change with every release."""
    return os.environ.get("APP_VERSION", __version__)


def dbos_config() -> DBOSConfig:
    settings = get_settings()
    return {
        "name": "tenderline",
        "system_database_url": settings.dbos_system_database_url,
        "application_version": application_version(),
        "log_level": settings.log_level,
        "enable_otlp": False,  # traces are exported by our own OpenTelemetry setup
    }


def is_running() -> bool:
    return _started


def start_runtime() -> bool:
    """Launch DBOS and register the queues and schedules. Returns True if this call started it."""
    global _started
    with _lock:
        if _started:
            return False
        # Importing the modules registers their workflows and steps with DBOS.
        from tenderline.workflows import ingestion, maintenance, notice_events, opportunity, qualification  # noqa: F401

        settings = get_settings()
        DBOS(config=dbos_config())
        DBOS.launch()
        DBOS.register_queue(QUEUE_ENRICH, worker_concurrency=settings.enrich_queue_concurrency)
        DBOS.register_queue(QUEUE_QUALIFY, worker_concurrency=settings.qualify_queue_concurrency)
        DBOS.register_queue(QUEUE_INGEST, global_concurrency=1)
        if settings.env != "test":
            DBOS.apply_schedules(
                [
                    {
                        "schedule_name": "ted-daily-ingestion",
                        "workflow_fn": ingestion.scheduled_ingestion,
                        "schedule": settings.ingest_cron,
                        "context": "ted",
                        "queue_name": QUEUE_INGEST,
                    },
                    {
                        "schedule_name": "approval-reconciler",
                        "workflow_fn": maintenance.reconcile_approvals,
                        "schedule": "*/2 * * * *",
                        "context": "approvals",
                    },
                    {
                        "schedule_name": "opportunity-workflow-reconciler",
                        "workflow_fn": maintenance.restart_orphaned_opportunity_workflows,
                        "schedule": "*/10 * * * *",
                        "context": "opportunities",
                    },
                    {
                        "schedule_name": "daily-cleanup",
                        "workflow_fn": maintenance.purge_old_records,
                        "schedule": "30 3 * * *",
                        "context": "retention",
                    },
                ]
            )
        _started = True
        log.info("DBOS runtime started (application version %s)", application_version())
        return True


def stop_runtime() -> None:
    global _started
    with _lock:
        if _started:
            DBOS.destroy()
            _started = False


def _require_running() -> None:
    if not _started:
        raise ApiError(503, "workflows_unavailable", "The workflow runtime is not running")


# ------------------------------------------------------------------ used by the API
def start_execution(org_id: uuid.UUID, proposal_id: uuid.UUID, traceparent: str | None = None) -> Any:
    """Start executing an approved proposal. The workflow id comes from the proposal id, so it runs once."""
    _require_running()
    from tenderline.workflows.opportunity import execute_proposal_workflow

    with SetWorkflowID(f"exec-{proposal_id}"):
        return DBOS.start_workflow(execute_proposal_workflow, str(org_id), str(proposal_id), traceparent)


def start_opportunity_workflow(org_id: uuid.UUID, opportunity_id: uuid.UUID, workflow_id: str) -> None:
    _require_running()
    from tenderline.workflows.opportunity import opportunity_workflow

    with SetWorkflowID(workflow_id):
        DBOS.start_workflow(opportunity_workflow, str(org_id), str(opportunity_id))


def notify_opportunity(workflow_id: str | None, reason: str) -> None:
    """Wake an opportunity workflow after the API changed something it cares about. Best effort."""
    if workflow_id and _started:
        wake_opportunity_workflow(workflow_id, reason)


def enqueue_qualify(org_id: uuid.UUID, match_id: uuid.UUID, idempotency_key: str) -> str:
    """Queue qualification of one match, as part of the caller's trace."""
    _require_running()
    from tenderline.workflows.qualification import qualify_workflow

    workflow_id = f"qualify-{org_id}-{match_id}-{idempotency_key}"[:200]
    with SetWorkflowID(workflow_id):
        DBOS.enqueue_workflow(QUEUE_QUALIFY, qualify_workflow, str(org_id), str(match_id), current_traceparent())
    return workflow_id


def enqueue_backfill(org_id: uuid.UUID, search_id: uuid.UUID) -> None:
    """Queue matching of a saved search against stored notices.

    Best effort: saving a search must succeed even when the workflow runtime is down. The search still matches
    every notice ingested afterwards.
    """
    if not _started:
        log.warning("workflow runtime not running; skipped backfill for search %s", search_id)
        return
    from tenderline.workflows.qualification import backfill_workflow

    DBOS.enqueue_workflow(QUEUE_ENRICH, backfill_workflow, str(org_id), str(search_id), current_traceparent())
