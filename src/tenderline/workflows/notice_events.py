"""What happens after a notice is stored: award handling, corrigendum handling, matching."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from dbos import DBOS
from sqlalchemy import select, text, update

from tenderline.audit import write_audit
from tenderline.db import public_session, tenant_session
from tenderline.matching import match_notice
from tenderline.models import AgentProposal, Deadline, Notice, Opportunity, Organisation
from tenderline.notices import normalise_name
from tenderline.observability import tracer
from tenderline.opportunities import CLOSED, change_status
from tenderline.workflows.qualification import qualify_workflow
from tenderline.workflows.queues import QUEUE_QUALIFY, wake_opportunity_workflow

FLAGGED_CHANGES = {"deadline_at", "estimated_value"}


@DBOS.workflow()
def process_notice_workflow(event: dict[str, Any]) -> dict[str, Any]:
    """Queue worker for one stored notice event: close awarded opportunities, handle a correction, then match."""
    summary: dict[str, Any] = {"notice_id": event["notice_id"]}
    if event["awarded_notice_ids"]:
        summary["awards"] = awards = close_awarded_opportunities(event)
        for workflow_id in awards["wake"]:
            wake_opportunity_workflow(workflow_id, "status_changed")
    if event["kind"] != "call":
        return summary
    if event["action"] == "updated":
        summary["corrigendum"] = corrigendum = apply_corrigendum(event)
        for workflow_id in corrigendum["wake"]:
            wake_opportunity_workflow(workflow_id, "deadlines_changed")
    new_matches = match_against_saved_searches(event["notice_id"])
    for org_id, match_id in new_matches:
        DBOS.enqueue_workflow(QUEUE_QUALIFY, qualify_workflow, org_id, match_id)
    summary["matches"] = len(new_matches)
    return summary


@DBOS.step()
def match_against_saved_searches(notice_id: str) -> list[list[str]]:
    with tracer().start_as_current_span("queue.match_notice", attributes={"tenderline.notice_id": notice_id}):
        return [[str(org_id), str(match_id)] for org_id, match_id in match_notice(uuid.UUID(notice_id))]


def _organisations_tracking(notice_id: uuid.UUID) -> list[uuid.UUID]:
    with public_session() as db:
        return [row[0] for row in db.execute(text("SELECT org_id FROM app_orgs_for_notice(:n)"), {"n": notice_id})]


# ---------------------------------------------------------------- corrigendum
@DBOS.step()
def apply_corrigendum(event: dict[str, Any]) -> dict[str, Any]:
    """A notice changed: cancel proposals made for the old version, flag changed deadlines and values on the
    opportunity, and move its deadline and reminders. Re-qualification follows from matching."""
    with tracer().start_as_current_span(
        "workflow.corrigendum", attributes={"tenderline.notice_id": event["notice_id"]}
    ):
        notice_id, version = uuid.UUID(event["notice_id"]), int(event["version"])
        changes: dict[str, Any] = event.get("changes") or {}
        flagged_fields = sorted(set(changes) & FLAGGED_CHANGES)
        with public_session() as db:
            new_deadline = db.scalar(select(Notice.deadline_at).where(Notice.id == notice_id))
        org_ids = _organisations_tracking(notice_id)
        summary: dict[str, Any] = {"orgs": len(org_ids), "cancelled": 0, "flagged": 0, "wake": []}
        for org_id in org_ids:
            workflow_to_wake = _apply_corrigendum_for(
                org_id, notice_id, version, changes, flagged_fields, new_deadline, summary
            )
            if workflow_to_wake:
                summary["wake"].append(workflow_to_wake)
        return summary


def _apply_corrigendum_for(
    org_id: uuid.UUID,
    notice_id: uuid.UUID,
    version: int,
    changes: dict[str, Any],
    flagged_fields: list[str],
    new_deadline: datetime | None,
    summary: dict[str, Any],
) -> str | None:
    with tenant_session(org_id) as db:
        outdated = db.scalars(
            select(AgentProposal).where(
                AgentProposal.notice_id == notice_id,
                AgentProposal.status == "pending",
                AgentProposal.notice_version < version,
            )
        ).all()
        for proposal in outdated:
            proposal.status = "cancelled"
            write_audit(
                db,
                org_id,
                actor_type="agent",
                actor_id="corrigendum-handler",
                action="proposal.cancelled",
                entity_type="agent_proposal",
                entity_id=proposal.id,
                before={"status": "pending", "notice_version": proposal.notice_version},
                after={"status": "cancelled", "reason": "notice corrected", "new_version": version},
            )
        summary["cancelled"] += len(outdated)

        opportunity = db.scalars(select(Opportunity).where(Opportunity.notice_id == notice_id)).first()
        if opportunity is None or not flagged_fields:
            return None
        opportunity.flags = {
            **opportunity.flags,
            "notice_changed": {
                "fields": flagged_fields,
                "version": version,
                "changes": {name: changes[name] for name in flagged_fields},
                "at": datetime.now(UTC).isoformat(),
            },
        }
        moved_reminders = 0
        if "deadline_at" in flagged_fields and new_deadline is not None:
            moved_reminders = _move_deadline_and_reminders(db, opportunity.id, new_deadline)
        write_audit(
            db,
            org_id,
            actor_type="agent",
            actor_id="corrigendum-handler",
            action="opportunity.flagged_changed",
            entity_type="opportunity",
            entity_id=opportunity.id,
            after={"fields": flagged_fields, "version": version, "reminders_moved": moved_reminders},
        )
        summary["flagged"] += 1
        return opportunity.workflow_id


def _move_deadline_and_reminders(db: Any, opportunity_id: uuid.UUID, new_deadline: datetime) -> int:
    """Move the notice's submission deadline, and every unfired "N days before" reminder along with it."""
    submission = db.scalars(
        select(Deadline).where(
            Deadline.opportunity_id == opportunity_id, Deadline.kind == "submission", Deadline.source == "notice"
        )
    ).first()
    if submission is not None:
        submission.due_at, submission.fired_at = new_deadline, None
    reminders = db.scalars(
        select(Deadline).where(
            Deadline.opportunity_id == opportunity_id,
            Deadline.kind == "reminder",
            Deadline.offset_days.is_not(None),
            Deadline.fired_at.is_(None),
        )
    ).all()
    for reminder in reminders:
        reminder.due_at = new_deadline - timedelta(days=reminder.offset_days)
    return len(reminders)


# ---------------------------------------------------------------- award
@DBOS.step()
def close_awarded_opportunities(event: dict[str, Any]) -> dict[str, Any]:
    """An award notice appeared: close every opportunity on the awarded calls and record the outcome."""
    with tracer().start_as_current_span("workflow.award", attributes={"tenderline.notice_id": event["notice_id"]}):
        closed = 0
        workflows_to_wake: list[str] = []
        for awarded_notice_id in event["awarded_notice_ids"]:
            notice_id = uuid.UUID(awarded_notice_id)
            with public_session() as db:
                award: dict[str, Any] = db.scalar(select(Notice.award).where(Notice.id == notice_id)) or {}
            winners = {normalise_name(winner) for winner in award.get("winners", [])} - {""}
            for org_id in _organisations_tracking(notice_id):
                workflow_id = _close_opportunity_for(org_id, notice_id, award, winners)
                if workflow_id:
                    closed += 1
                    workflows_to_wake.append(workflow_id)
            with public_session() as db:
                db.execute(update(Notice).where(Notice.id == notice_id).values(status="awarded"))
        return {"closed_opportunities": closed, "wake": workflows_to_wake}


def _close_opportunity_for(
    org_id: uuid.UUID, notice_id: uuid.UUID, award: dict[str, Any], winners: set[str]
) -> str | None:
    """Cancel pending proposals and close the opportunity. Returns its workflow id, or None if nothing closed."""
    with tenant_session(org_id) as db:
        pending = db.scalars(
            select(AgentProposal).where(AgentProposal.notice_id == notice_id, AgentProposal.status == "pending")
        ).all()
        for proposal in pending:
            proposal.status = "cancelled"
            write_audit(
                db,
                org_id,
                actor_type="agent",
                actor_id="award-handler",
                action="proposal.cancelled",
                entity_type="agent_proposal",
                entity_id=proposal.id,
                after={"reason": "contract awarded"},
            )
        opportunity = db.scalars(select(Opportunity).where(Opportunity.notice_id == notice_id)).first()
        if opportunity is None or opportunity.status in CLOSED:
            return None
        outcome: dict[str, Any] = {"award": award, "source": "award notice"}
        if opportunity.status == "submitted":
            organisation = db.get(Organisation, org_id)
            assert organisation is not None
            # Only an exact match on the normalised name counts as a win. Company names on award notices vary
            # (trading names, consortia), so anything else is recorded as lost and flagged for a person to check.
            won = normalise_name(organisation.name) in winners
            outcome["matched_by"] = "organisation name"
            if not won:
                opportunity.flags = {**opportunity.flags, "outcome_needs_review": True}
            change_status(
                db,
                org_id,
                opportunity,
                "won" if won else "lost",
                actor_type="agent",
                actor_id="award-handler",
                outcome=outcome,
                reason="award notice published",
            )
        else:
            change_status(
                db,
                org_id,
                opportunity,
                "no_bid",
                actor_type="agent",
                actor_id="award-handler",
                force=True,
                outcome=outcome,
                reason="contract awarded before a bid was submitted",
            )
        return opportunity.workflow_id or f"opp-{opportunity.id}"
