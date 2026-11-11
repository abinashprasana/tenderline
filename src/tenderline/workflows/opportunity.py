"""Executing an approved proposal, and the long-running workflow that tracks one opportunity."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from dbos import DBOS, SetWorkflowID
from sqlalchemy import func, select, text

from tenderline.agent.tools import run_proposal
from tenderline.audit import write_audit
from tenderline.config import get_settings
from tenderline.db import tenant_session
from tenderline.faults import maybe_crash
from tenderline.models import Deadline, Opportunity
from tenderline.observability import continue_trace, tracer
from tenderline.opportunities import CLOSED
from tenderline.workflows.queues import EVENTS_TOPIC, wake_opportunity_workflow


# ---------------------------------------------------------------- approved proposal
@DBOS.step()
def run_approved_proposal(org_id: str, proposal_id: str, traceparent: str | None = None) -> dict[str, Any]:
    with continue_trace(traceparent, "workflow.execute_proposal", {"tenderline.proposal_id": proposal_id}):
        outcome = run_proposal(uuid.UUID(org_id), uuid.UUID(proposal_id))
    maybe_crash("after_tool_commit")  # test hook: die after the commit but before DBOS records the step
    return outcome


@DBOS.step()
def workflow_id_of(org_id: str, opportunity_id: str) -> str:
    with tenant_session(org_id) as db:
        workflow_id = db.scalar(select(Opportunity.workflow_id).where(Opportunity.id == uuid.UUID(opportunity_id)))
    return str(workflow_id or f"opp-{opportunity_id}")


@DBOS.workflow()
def execute_proposal_workflow(org_id: str, proposal_id: str, traceparent: str | None = None) -> dict[str, Any]:
    """Run an approved proposal. Its workflow id is derived from the proposal id, so it cannot start twice."""
    outcome = run_approved_proposal(org_id, proposal_id, traceparent)
    opportunity_id = (outcome.get("result") or {}).get("opportunity_id")
    if outcome["status"] == "executed" and opportunity_id:
        workflow_id = workflow_id_of(org_id, opportunity_id)
        with SetWorkflowID(workflow_id):
            DBOS.start_workflow(opportunity_workflow, org_id, opportunity_id)
        wake_opportunity_workflow(workflow_id, "proposal_executed", proposal_id=proposal_id)
    return outcome


# ---------------------------------------------------------------- opportunity
@DBOS.step()
def read_opportunity_state(org_id: str, opportunity_id: str) -> dict[str, Any]:
    """Is the opportunity still open, and how long until its next unfired reminder or deadline?"""
    longest_wait = get_settings().opportunity_max_wait_seconds
    with tenant_session(org_id) as db:
        opportunity = db.get(Opportunity, uuid.UUID(opportunity_id))
        if opportunity is None or opportunity.closed_at is not None or opportunity.status in CLOSED:
            return {"closed": True, "wait": 0.0}
        now: datetime = db.execute(select(func.clock_timestamp())).scalar_one()
        next_due: datetime | None = db.scalar(
            select(func.min(Deadline.due_at)).where(
                Deadline.opportunity_id == opportunity.id, Deadline.fired_at.is_(None)
            )
        )
    wait = longest_wait if next_due is None else (next_due - now).total_seconds()
    return {"closed": False, "wait": float(max(0.0, min(wait, longest_wait)))}


@DBOS.step()
def note_signal(org_id: str, opportunity_id: str, signal: dict[str, Any]) -> None:
    """Record the one signal that carries data. The others only exist to wake the workflow early."""
    if signal.get("type") != "proposal_executed":
        return
    with tenant_session(org_id) as db:
        opportunity = db.get(Opportunity, uuid.UUID(opportunity_id))
        if opportunity is not None:
            opportunity.flags = {**opportunity.flags, "last_proposal_executed": signal.get("proposal_id")}


@DBOS.step()
def fire_due_deadlines(org_id: str, opportunity_id: str) -> list[str]:
    """Mark every due reminder and deadline as fired and write an audit entry for each.

    Exactly once: the rows are locked and `fired_at` is set in the same transaction, so a retried step or a
    second workflow for the same opportunity finds nothing left to fire.
    """
    fired: list[str] = []
    with (
        tracer().start_as_current_span("workflow.fire_due", attributes={"tenderline.opportunity_id": opportunity_id}),
        tenant_session(org_id) as db,
    ):
        due = db.scalars(
            select(Deadline)
            .where(
                Deadline.opportunity_id == uuid.UUID(opportunity_id),
                Deadline.fired_at.is_(None),
                Deadline.due_at <= text("clock_timestamp()"),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for deadline in due:
            deadline.fired_at = datetime.now(UTC)
            write_audit(
                db,
                uuid.UUID(org_id),
                actor_type="agent",
                actor_id="scheduler",
                action="deadline.passed" if deadline.kind == "submission" else "reminder.fired",
                entity_type="deadline",
                entity_id=deadline.id,
                after={
                    "kind": deadline.kind,
                    "due_at": deadline.due_at.isoformat(),
                    "note": deadline.note,
                    "opportunity_id": opportunity_id,
                },
            )
            fired.append(str(deadline.id))
    return fired


@DBOS.workflow()
def opportunity_workflow(org_id: str, opportunity_id: str) -> str:
    """One per opportunity. Waits until the next reminder or deadline, fires it, and ends when the opportunity
    closes.

    `DBOS.recv` with a timeout is the durable timer: its wake-up time is checkpointed, so a restart neither
    loses nor repeats it. A signal (approval executed, status change, corrigendum) ends the wait early and the
    loop re-reads the database, which is the source of truth.
    """
    while True:
        state = read_opportunity_state(org_id, opportunity_id)
        if state["closed"]:
            return "closed"
        signal = DBOS.recv(EVENTS_TOPIC, timeout_seconds=state["wait"])
        if signal is not None:
            note_signal(org_id, opportunity_id, signal)
            continue
        fire_due_deadlines(org_id, opportunity_id)
