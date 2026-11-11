"""Scheduled housekeeping: finish what a crash or a deploy interrupted, and delete what is no longer needed."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from dbos import DBOS, SetWorkflowID
from sqlalchemy import text

from tenderline.config import get_settings
from tenderline.db import public_session, tenant_session
from tenderline.models import Opportunity
from tenderline.opportunities import workflow_id_for
from tenderline.workflows.opportunity import execute_proposal_workflow, opportunity_workflow

log = logging.getLogger(__name__)

LIVE_STATUSES = {"PENDING", "ENQUEUED", "DELAYED"}
FINISHED_STATUSES = ["SUCCESS", "ERROR", "CANCELLED"]


# ---------------------------------------------------------------- approvals whose execution never started
@DBOS.step()
def find_unstarted_approvals(older_than_seconds: int) -> list[list[str]]:
    with public_session() as db:
        rows = db.execute(
            text("SELECT org_id, proposal_id FROM app_stale_approved_proposals(make_interval(secs => :s))"),
            {"s": older_than_seconds},
        ).all()
    return [[str(org_id), str(proposal_id)] for org_id, proposal_id in rows]


@DBOS.workflow()
def reconcile_approvals(scheduled_time: datetime, context: Any) -> None:
    """Start the execution of approved proposals that never got one.

    The API starts the execution right after the approval commits. If the process dies in between, this picks
    it up. The workflow id is derived from the proposal id, so an action can never run twice.
    """
    for org_id, proposal_id in find_unstarted_approvals(60):
        with SetWorkflowID(f"exec-{proposal_id}"):
            DBOS.start_workflow(execute_proposal_workflow, org_id, proposal_id)


# ---------------------------------------------------------------- opportunities with no live workflow
@DBOS.step()
def list_open_opportunities() -> list[list[str]]:
    with public_session() as db:
        rows = db.execute(
            text("SELECT org_id, opportunity_id, workflow_id FROM app_open_opportunities(interval '2 minutes')")
        ).all()
    return [[str(org_id), str(opportunity_id), workflow_id or ""] for org_id, opportunity_id, workflow_id in rows]


@DBOS.step()
def assign_new_workflow_id(org_id: str, opportunity_id: str) -> str:
    with tenant_session(org_id) as db:
        opportunity = db.get(Opportunity, uuid.UUID(opportunity_id))
        if opportunity is None:
            return ""
        generation = int(opportunity.flags.get("generation", 0)) + 1
        opportunity.flags = {**opportunity.flags, "generation": generation}
        opportunity.workflow_id = workflow_id_for(opportunity.id, generation)
        return opportunity.workflow_id


@DBOS.workflow()
def restart_orphaned_opportunity_workflows(scheduled_time: datetime, context: Any) -> None:
    """Give every open opportunity a live workflow on the running application version.

    DBOS only resumes workflows that were started by the same application version. After a deploy, the
    workflows of the previous version would stay parked forever and reminders would silently stop. This finds
    open opportunities without a live workflow on this version and starts a fresh one. Firing a reminder is
    exactly-once at the row level, so an overlap between an old and a new workflow is harmless.
    """
    from tenderline.workflows.runtime import application_version

    open_opportunities = list_open_opportunities()
    workflow_ids = [workflow_id for _, _, workflow_id in open_opportunities if workflow_id]
    live: set[str] = set()
    if workflow_ids:
        for status in DBOS.list_workflows(workflow_ids=workflow_ids, load_input=False, load_output=False):
            if status.status in LIVE_STATUSES and status.app_version == application_version():
                live.add(status.workflow_id)
    restarted = 0
    for org_id, opportunity_id, workflow_id in open_opportunities:
        if workflow_id in live:
            continue
        new_workflow_id = assign_new_workflow_id(org_id, opportunity_id)
        if not new_workflow_id:
            continue
        with SetWorkflowID(new_workflow_id):
            DBOS.start_workflow(opportunity_workflow, org_id, opportunity_id)
        restarted += 1
    if restarted:
        log.info("restarted %d opportunity workflows", restarted)


# ---------------------------------------------------------------- retention
@DBOS.step()
def purge_idempotency_keys(retention_days: int) -> int:
    with public_session() as db:
        deleted: int = db.execute(
            text("SELECT app_purge_idempotency_keys(make_interval(days => :d))"), {"d": retention_days}
        ).scalar_one()
    return deleted


@DBOS.step()
def retention_cutoff(retention_days: int) -> str:
    return (datetime.now(UTC) - timedelta(days=retention_days)).isoformat()


@DBOS.workflow()
def purge_old_records(scheduled_time: datetime, context: Any) -> None:
    """Delete finished workflow records and idempotency keys past their retention period.

    Neither has any value once it is old, and the workflow tables otherwise grow without limit (a single load
    test left 43,000 rows). The audit log and notice versions are never touched.
    """
    settings = get_settings()
    keys = purge_idempotency_keys(settings.idempotency_key_retention_days)
    cutoff = retention_cutoff(settings.workflow_retention_days)
    finished = DBOS.list_workflows(
        status=FINISHED_STATUSES, end_time=cutoff, limit=5000, load_input=False, load_output=False
    )
    for status in finished:
        DBOS.delete_workflow(status.workflow_id)
    log.info("cleanup removed %d idempotency keys and %d finished workflows", keys, len(finished))
