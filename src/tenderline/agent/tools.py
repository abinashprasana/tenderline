"""The typed tool layer. Tools run only for an APPROVED proposal, exactly once.

Exactly-once: `run_proposal` locks the proposal row, runs the tool and flips the proposal to `executed` in ONE
transaction. A crash before commit leaves the proposal `approved` (nothing happened); after commit it is
`executed` and any retry returns the stored result without touching anything. The DBOS workflow that calls it
also uses the proposal id as its workflow id, so concurrent starts collapse into one execution.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from tenderline.agent.schema import validate_payload
from tenderline.audit import write_audit
from tenderline.db import tenant_session
from tenderline.models import AgentProposal, Approval, Deadline, Membership, Notice, Opportunity
from tenderline.opportunities import change_status, ensure_opportunity, snapshot

REVIEWER_ROLES = ("reviewer", "bid_manager", "owner")


class ToolError(Exception):
    """A precondition failed; the proposal is marked failed with this message."""


def _create_opportunity(
    db: Session, org: uuid.UUID, p: AgentProposal, payload: dict[str, Any], actor: str
) -> dict[str, Any]:
    opp, created = ensure_opportunity(db, org, p.notice_id, actor_type="human", actor_id=actor, via=f"proposal:{p.id}")
    return {"opportunity_id": str(opp.id), "created": created}


def _add_deadline_reminders(
    db: Session, org: uuid.UUID, p: AgentProposal, payload: dict[str, Any], actor: str
) -> dict[str, Any]:
    opp, _ = ensure_opportunity(db, org, p.notice_id, actor_type="human", actor_id=actor, via=f"proposal:{p.id}")
    notice = db.get(Notice, p.notice_id)
    assert notice is not None
    deadline = (
        db.scalars(
            select(Deadline.due_at)
            .where(Deadline.opportunity_id == opp.id, Deadline.kind == "submission")
            .order_by(Deadline.due_at.desc())
        ).first()
        or notice.deadline_at
    )
    if deadline is None:
        raise ToolError("the notice has no tender deadline to count back from")
    now, created = datetime.now(UTC), []
    for days in payload["days_before"]:
        due = deadline - timedelta(days=days)
        if due <= now:
            continue
        db.add(
            Deadline(
                organisation_id=org,
                opportunity_id=opp.id,
                kind="reminder",
                due_at=due,
                source="agent",
                proposal_id=p.id,
                offset_days=days,
                note=f"{days} days before the submission deadline",
            )
        )
        created.append(due.isoformat())
    db.flush()
    return {
        "opportunity_id": str(opp.id),
        "reminders": created,
        "skipped_past": len(payload["days_before"]) - len(created),
    }


def _assign_reviewer(
    db: Session, org: uuid.UUID, p: AgentProposal, payload: dict[str, Any], actor: str
) -> dict[str, Any]:
    uid = uuid.UUID(payload["user_id"])
    role = db.scalars(select(Membership.role).where(Membership.user_id == uid)).first()
    if role not in REVIEWER_ROLES:
        raise ToolError("that user is not a member who can review")
    opp, _ = ensure_opportunity(db, org, p.notice_id, actor_type="human", actor_id=actor, via=f"proposal:{p.id}")
    before = snapshot(opp)
    opp.assigned_reviewer_id = uid
    db.flush()
    write_audit(
        db,
        org,
        actor_type="human",
        actor_id=actor,
        action="opportunity.reviewer_assigned",
        entity_type="opportunity",
        entity_id=opp.id,
        before=before,
        after=snapshot(opp),
    )
    return {"opportunity_id": str(opp.id), "reviewer_id": str(uid)}


def _draft_clarification(
    db: Session, org: uuid.UUID, p: AgentProposal, payload: dict[str, Any], actor: str
) -> dict[str, Any]:
    opp, _ = ensure_opportunity(db, org, p.notice_id, actor_type="human", actor_id=actor, via=f"proposal:{p.id}")
    drafts = list(opp.flags.get("clarification_drafts", []))
    drafts.append({"proposal_id": str(p.id), "question": payload["question"], "status": "draft"})
    opp.flags = {**opp.flags, "clarification_drafts": drafts}  # a draft only: Tenderline never contacts buyers
    db.flush()
    return {"opportunity_id": str(opp.id), "drafts": len(drafts)}


def _mark_no_bid(db: Session, org: uuid.UUID, p: AgentProposal, payload: dict[str, Any], actor: str) -> dict[str, Any]:
    opp, _ = ensure_opportunity(db, org, p.notice_id, actor_type="human", actor_id=actor, via=f"proposal:{p.id}")
    if opp.status in ("submitted", "won", "lost"):
        raise ToolError(f"opportunity is already {opp.status}")
    change_status(db, org, opp, "no_bid", actor_type="human", actor_id=actor, reason=payload["reason"], force=True)
    return {"opportunity_id": str(opp.id), "status": "no_bid"}


TOOLS = {
    "create_opportunity": _create_opportunity,
    "add_deadline_reminders": _add_deadline_reminders,
    "assign_reviewer": _assign_reviewer,
    "draft_clarification_question": _draft_clarification,
    "mark_no_bid": _mark_no_bid,
}


def run_proposal(org_id: uuid.UUID, proposal_id: uuid.UUID) -> dict[str, Any]:
    """Execute an approved proposal exactly once. Idempotent: a second call returns the stored result."""
    with tenant_session(org_id) as db:
        p = db.execute(select(AgentProposal).where(AgentProposal.id == proposal_id).with_for_update()).scalar_one()
        if p.status in ("executed", "failed"):
            return {"status": p.status, "result": p.result, "replayed": True}
        if p.status != "approved":
            raise ToolError(f"proposal is {p.status}, only approved proposals can run")
        approval = db.scalars(select(Approval).where(Approval.proposal_id == proposal_id)).one()
        actor = str(approval.decided_by)
        try:
            payload = validate_payload(p.action_type, approval.edited_payload or p.payload)
            with db.begin_nested():  # a failing tool must not leave half its writes behind
                result = TOOLS[p.action_type](db, org_id, p, payload, actor)
            status = "executed"
        except (ToolError, ValidationError, KeyError) as exc:
            result, status = {"error": str(exc)[:500]}, "failed"
        p.status, p.result, p.executed_at = status, result, datetime.now(UTC)
        db.flush()
        write_audit(
            db,
            org_id,
            actor_type="human",
            actor_id=actor,
            action=f"proposal.{status}",
            entity_type="agent_proposal",
            entity_id=proposal_id,
            after={"action_type": p.action_type, "result": result},
        )
        return {"status": status, "result": result, "replayed": False}


def opportunity_for_notice(org_id: uuid.UUID, notice_id: uuid.UUID) -> Opportunity | None:
    with tenant_session(org_id) as db:
        return db.scalars(select(Opportunity).where(Opportunity.notice_id == notice_id)).first()
