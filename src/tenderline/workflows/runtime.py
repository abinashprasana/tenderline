"""DBOS runtime lifecycle and the helpers the API uses to start and signal workflows."""

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

log = logging.getLogger(__name__)

_lock = threading.Lock()
_started = False


def dbos_config() -> DBOSConfig:
    s = get_settings()
    return {
        "name": "tenderline",
        "system_database_url": s.dbos_system_database_url,
        "application_version": os.environ.get("APP_VERSION", __version__),
        "log_level": s.log_level,
        "enable_otlp": False,  # traces are exported by our own OpenTelemetry setup
    }


def is_running() -> bool:
    return _started


def start_runtime() -> bool:
    """Launch DBOS, register queues and the daily ingestion schedule. Idempotent; returns True if started here."""
    global _started
    with _lock:
        if _started:
            return False
        from tenderline.workflows import tasks  # registers workflows and steps

        s = get_settings()
        DBOS(config=dbos_config())
        DBOS.launch()
        DBOS.register_queue(tasks.QUEUE_ENRICH, worker_concurrency=s.enrich_queue_concurrency)
        DBOS.register_queue(tasks.QUEUE_QUALIFY, worker_concurrency=s.qualify_queue_concurrency)
        if s.env != "test":
            DBOS.apply_schedules(
                [
                    {
                        "schedule_name": "ted-daily-ingestion",
                        "workflow_fn": tasks.scheduled_ingestion,
                        "schedule": s.ingest_cron,
                        "context": "ted",
                    },
                    {
                        "schedule_name": "approval-reconciler",
                        "workflow_fn": tasks.reconcile_approvals,
                        "schedule": "*/2 * * * *",
                        "context": "approvals",
                    },
                ]
            )
        _started = True
        log.info("DBOS runtime started")
        return True


def stop_runtime() -> None:
    global _started
    with _lock:
        if _started:
            DBOS.destroy()
            _started = False


def _require() -> None:
    if not _started:
        raise ApiError(503, "workflows_unavailable", "The workflow runtime is not running")


# ------------------------------------------------------------------ helpers used by the API
def start_execution(org_id: uuid.UUID, proposal_id: uuid.UUID) -> Any:
    """Start executing an approved proposal. The workflow id is the proposal id: it can only run once."""
    _require()
    from tenderline.workflows.tasks import execute_proposal_workflow

    with SetWorkflowID(f"exec-{proposal_id}"):
        return DBOS.start_workflow(execute_proposal_workflow, str(org_id), str(proposal_id))


def start_opportunity_workflow(org_id: uuid.UUID, opp_id: uuid.UUID, workflow_id: str) -> None:
    _require()
    from tenderline.workflows.tasks import opportunity_workflow

    with SetWorkflowID(workflow_id):
        DBOS.start_workflow(opportunity_workflow, str(org_id), str(opp_id))


def notify_opportunity(workflow_id: str | None, msg_type: str, **fields: Any) -> None:
    """Wake an opportunity workflow. Best effort: a finished workflow simply has nothing to wake."""
    if not workflow_id or not _started:
        return
    try:
        DBOS.send(workflow_id, {"type": msg_type, **fields}, "events")
    except Exception:  # noqa: BLE001 - destination may have completed
        log.info("could not signal workflow %s", workflow_id, exc_info=True)


def enqueue_process_notice(event: dict[str, Any]) -> None:
    _require()
    from tenderline.workflows.tasks import QUEUE_ENRICH, process_notice_workflow

    DBOS.enqueue_workflow(QUEUE_ENRICH, process_notice_workflow, event)


def trigger_ingestion(since_iso: str | None = None) -> str:
    _require()
    from tenderline.workflows.tasks import ingest_ted_workflow

    handle = DBOS.start_workflow(ingest_ted_workflow, since_iso)
    return str(handle.workflow_id)
