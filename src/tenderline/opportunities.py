"""Opportunity domain logic shared by the API, the agent tools and the workflows."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from tenderline.audit import write_audit
from tenderline.errors import ApiError
from tenderline.models import Deadline, Notice, Opportunity

STATUSES = ("new", "bid", "no_bid", "submitted", "won", "lost")
TRANSITIONS: dict[str, set[str]] = {
    "new": {"bid", "no_bid"},
    "bid": {"submitted", "no_bid"},
    "no_bid": {"bid"},
    "submitted": {"won", "lost"},
    "won": set(),
    "lost": set(),
}
CLOSED = {"no_bid", "won", "lost"}


def workflow_id_for(opp_id: uuid.UUID, generation: int = 0) -> str:
    return f"opp-{opp_id}" if generation == 0 else f"opp-{opp_id}-r{generation}"


def snapshot(o: Opportunity) -> dict[str, Any]:
    return {
        "status": o.status,
        "outcome": o.outcome,
        "assigned_reviewer_id": str(o.assigned_reviewer_id) if o.assigned_reviewer_id else None,
        "closed_at": o.closed_at.isoformat() if o.closed_at else None,
    }


def ensure_opportunity(
    db: Session, org_id: uuid.UUID, notice_id: uuid.UUID, *, actor_type: str, actor_id: str, via: str | None = None
) -> tuple[Opportunity, bool]:
    """Get or create the opportunity for a notice (one per organisation and notice)."""
    existing = db.scalars(select(Opportunity).where(Opportunity.notice_id == notice_id)).first()
    if existing is not None:
        return existing, False
    notice = db.get(Notice, notice_id)
    if notice is None:
        raise ApiError(404, "not_found", "Notice not found")
    opp = Opportunity(organisation_id=org_id, notice_id=notice_id, status="new", flags={})
    db.add(opp)
    db.flush()
    opp.workflow_id = workflow_id_for(opp.id)
    if notice.deadline_at is not None:
        db.add(
            Deadline(
                organisation_id=org_id,
                opportunity_id=opp.id,
                kind="submission",
                due_at=notice.deadline_at,
                note="Tender submission deadline (from notice)",
                source="notice",
            )
        )
    db.flush()
    write_audit(
        db,
        org_id,
        actor_type=actor_type,
        actor_id=actor_id,
        action="opportunity.created",
        entity_type="opportunity",
        entity_id=opp.id,
        after={"notice_id": str(notice_id), "via": via, **snapshot(opp)},
    )
    return opp, True


def change_status(
    db: Session,
    org_id: uuid.UUID,
    opp: Opportunity,
    new: str,
    *,
    actor_type: str,
    actor_id: str,
    reason: str | None = None,
    outcome: dict[str, Any] | None = None,
    force: bool = False,
) -> None:
    if new not in STATUSES:
        raise ApiError(422, "invalid_status", f"status must be one of {list(STATUSES)}")
    if new == opp.status:
        return
    if not force and new not in TRANSITIONS[opp.status]:
        raise ApiError(
            409,
            "invalid_transition",
            f"cannot move from {opp.status!r} to {new!r}",
            {"allowed": sorted(TRANSITIONS[opp.status])},
        )
    before = snapshot(opp)
    opp.status = new
    if new in CLOSED:
        opp.closed_at = datetime.now(UTC)
        opp.outcome = {**(outcome or {}), **({"reason": reason} if reason else {})} or opp.outcome
    else:
        opp.closed_at = None
        if opp.status == "bid" and before["status"] == "no_bid":
            gen = int(opp.flags.get("generation", 0)) + 1
            opp.flags = {**opp.flags, "generation": gen}
            opp.workflow_id = workflow_id_for(opp.id, gen)  # the previous workflow ended when it was closed
    db.flush()
    write_audit(
        db,
        org_id,
        actor_type=actor_type,
        actor_id=actor_id,
        action="opportunity.status_changed",
        entity_type="opportunity",
        entity_id=opp.id,
        before=before,
        after={**snapshot(opp), "reason": reason},
    )
