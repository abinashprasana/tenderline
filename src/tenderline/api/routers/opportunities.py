from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, BackgroundTasks
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from tenderline.api.deps import CanRead, CanWrite, Ctx, IdemKey, idempotent
from tenderline.audit import write_audit
from tenderline.errors import ApiError, not_found
from tenderline.models import AgentProposal, Deadline, Notice, Opportunity
from tenderline.opportunities import change_status, ensure_opportunity, snapshot
from tenderline.pagination import paginate
from tenderline.workflows import runtime

router = APIRouter(prefix="/v1/organisations/{org_id}", tags=["opportunities", "deadlines"])


class DeadlineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    opportunity_id: uuid.UUID
    kind: str
    due_at: datetime
    note: str | None
    source: str
    proposal_id: uuid.UUID | None
    fired_at: datetime | None


class OpportunityOut(BaseModel):
    id: uuid.UUID
    notice_id: uuid.UUID
    notice_title: str
    status: str
    outcome: dict[str, Any] | None
    assigned_reviewer_id: uuid.UUID | None
    flags: dict[str, Any]
    workflow_id: str | None
    closed_at: datetime | None
    created_at: datetime
    deadlines: list[DeadlineOut] = []
    pending_proposals: int = 0


class OpportunityPage(BaseModel):
    items: list[OpportunityOut]
    next_cursor: str | None


class OpportunityIn(BaseModel):
    notice_id: uuid.UUID


class StatusIn(BaseModel):
    status: str
    reason: str | None = Field(default=None, max_length=500)


class DeadlineIn(BaseModel):
    kind: str = Field(default="custom", pattern="^(custom|reminder|clarification)$")
    due_at: datetime
    note: str | None = Field(default=None, max_length=500)


class RemindersIn(BaseModel):
    days_before: list[int] = Field(min_length=1, max_length=6)


def _titles(db: Any, opps: list[Opportunity]) -> dict[uuid.UUID, str]:
    ids = {o.notice_id for o in opps}
    return (
        {nid: title for nid, title in db.execute(select(Notice.id, Notice.title).where(Notice.id.in_(ids)))}
        if ids
        else {}
    )


def _opp_out(db: Any, o: Opportunity, with_children: bool = True, title: str | None = None) -> OpportunityOut:
    if title is None:
        notice = db.get(Notice, o.notice_id)
        title = notice.title if notice else ""
    out = OpportunityOut(
        id=o.id,
        notice_id=o.notice_id,
        notice_title=notice.title if notice else "",
        status=o.status,
        outcome=o.outcome,
        assigned_reviewer_id=o.assigned_reviewer_id,
        flags=o.flags,
        workflow_id=o.workflow_id,
        closed_at=o.closed_at,
        created_at=o.created_at,
    )
    if with_children:
        out.deadlines = [
            DeadlineOut.model_validate(d)
            for d in db.scalars(select(Deadline).where(Deadline.opportunity_id == o.id).order_by(Deadline.due_at))
        ]
        out.pending_proposals = len(
            db.scalars(
                select(AgentProposal.id).where(
                    AgentProposal.notice_id == o.notice_id, AgentProposal.status == "pending"
                )
            ).all()
        )
    return out


@router.get("/opportunities", response_model=OpportunityPage)
def list_opportunities(
    org_id: uuid.UUID,
    ctx: CanRead,
    status: str | None = None,
    notice_id: uuid.UUID | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> OpportunityPage:
    stmt = select(Opportunity)
    if status:
        stmt = stmt.where(Opportunity.status == status)
    if notice_id:
        stmt = stmt.where(Opportunity.notice_id == notice_id)
    rows, nxt = paginate(ctx.db, stmt, Opportunity.created_at, Opportunity.id, cursor, limit)
    titles = _titles(ctx.db, rows)
    items = [_opp_out(ctx.db, o, with_children=False, title=titles.get(o.notice_id, "")) for o in rows]
    return OpportunityPage(items=items, next_cursor=nxt)


def _get(ctx: Ctx, opp_id: uuid.UUID) -> Opportunity:
    o = ctx.db.get(Opportunity, opp_id)
    if o is None:
        raise not_found("Opportunity")
    return o


@router.get("/opportunities/{opp_id}", response_model=OpportunityOut)
def get_opportunity(org_id: uuid.UUID, opp_id: uuid.UUID, ctx: CanRead) -> OpportunityOut:
    return _opp_out(ctx.db, _get(ctx, opp_id))


@router.post(
    "/opportunities",
    status_code=201,
    response_model=OpportunityOut,
    summary="Track a notice manually (idempotent per notice)",
)
def create_opportunity(
    org_id: uuid.UUID, payload: OpportunityIn, ctx: CanWrite, key: IdemKey, bg: BackgroundTasks
) -> JSONResponse:
    def run() -> tuple[int, Any]:
        opp, created = ensure_opportunity(
            ctx.db, org_id, payload.notice_id, actor_type="human", actor_id=str(ctx.user_id), via="api"
        )
        if created:
            bg.add_task(runtime.start_opportunity_workflow, org_id, opp.id, opp.workflow_id or f"opp-{opp.id}")
        return (201 if created else 200), _opp_out(ctx.db, opp)

    return idempotent(ctx.db, org_id, key, payload, run)


@router.patch(
    "/opportunities/{opp_id}/status",
    response_model=OpportunityOut,
    summary="Change status: bid, no_bid, submitted, won, lost",
)
def set_status(
    org_id: uuid.UUID, opp_id: uuid.UUID, payload: StatusIn, ctx: CanWrite, bg: BackgroundTasks
) -> OpportunityOut:
    opp = _get(ctx, opp_id)
    old_wid = opp.workflow_id
    change_status(
        ctx.db, org_id, opp, payload.status, actor_type="human", actor_id=str(ctx.user_id), reason=payload.reason
    )
    if opp.workflow_id != old_wid and opp.workflow_id:  # reopened: a new workflow generation tracks it again
        bg.add_task(runtime.start_opportunity_workflow, org_id, opp.id, opp.workflow_id)
    else:
        bg.add_task(runtime.notify_opportunity, opp.workflow_id, "status_changed")
    return _opp_out(ctx.db, opp)


# ------------------------------------------------------------------ deadlines and reminders
@router.get("/opportunities/{opp_id}/deadlines", response_model=list[DeadlineOut])
def list_deadlines(org_id: uuid.UUID, opp_id: uuid.UUID, ctx: CanRead) -> list[Deadline]:
    _get(ctx, opp_id)
    return list(ctx.db.scalars(select(Deadline).where(Deadline.opportunity_id == opp_id).order_by(Deadline.due_at)))


@router.post("/opportunities/{opp_id}/deadlines", status_code=201, response_model=DeadlineOut)
def add_deadline(
    org_id: uuid.UUID, opp_id: uuid.UUID, payload: DeadlineIn, ctx: CanWrite, key: IdemKey, bg: BackgroundTasks
) -> JSONResponse:
    opp = _get(ctx, opp_id)

    def run() -> tuple[int, Any]:
        if payload.due_at <= datetime.now(UTC):
            raise ApiError(422, "deadline_in_past", "due_at must be in the future")
        d = Deadline(
            organisation_id=org_id,
            opportunity_id=opp_id,
            kind=payload.kind,
            due_at=payload.due_at,
            note=payload.note,
            source="human",
        )
        ctx.db.add(d)
        ctx.db.flush()
        write_audit(
            ctx.db,
            org_id,
            actor_type="human",
            actor_id=str(ctx.user_id),
            action="deadline.created",
            entity_type="deadline",
            entity_id=d.id,
            after={"kind": d.kind, "due_at": d.due_at.isoformat()},
        )
        bg.add_task(runtime.notify_opportunity, opp.workflow_id, "deadlines_changed")
        return 201, DeadlineOut.model_validate(d)

    return idempotent(ctx.db, org_id, key, payload, run)


@router.post(
    "/opportunities/{opp_id}/reminders",
    status_code=201,
    response_model=list[DeadlineOut],
    summary="Add reminders N days before the submission deadline",
)
def add_reminders(
    org_id: uuid.UUID, opp_id: uuid.UUID, payload: RemindersIn, ctx: CanWrite, key: IdemKey, bg: BackgroundTasks
) -> JSONResponse:
    opp = _get(ctx, opp_id)

    def run() -> tuple[int, Any]:
        sub = ctx.db.scalars(
            select(Deadline)
            .where(Deadline.opportunity_id == opp_id, Deadline.kind == "submission")
            .order_by(Deadline.due_at.desc())
        ).first()
        if sub is None:
            raise ApiError(
                409, "no_submission_deadline", "This opportunity has no submission deadline to count back from"
            )
        created = []
        for days in sorted({d for d in payload.days_before if 1 <= d <= 90}, reverse=True):
            due = sub.due_at - timedelta(days=days)
            if due <= datetime.now(UTC):
                continue
            d = Deadline(
                organisation_id=org_id,
                opportunity_id=opp_id,
                kind="reminder",
                due_at=due,
                source="human",
                note=f"{days} days before the submission deadline",
            )
            ctx.db.add(d)
            ctx.db.flush()
            write_audit(
                ctx.db,
                org_id,
                actor_type="human",
                actor_id=str(ctx.user_id),
                action="deadline.created",
                entity_type="deadline",
                entity_id=d.id,
                after={"kind": "reminder", "due_at": due.isoformat()},
            )
            created.append(DeadlineOut.model_validate(d))
        bg.add_task(runtime.notify_opportunity, opp.workflow_id, "deadlines_changed")
        return 201, created

    return idempotent(ctx.db, org_id, key, payload, run)


@router.delete("/deadlines/{deadline_id}", status_code=204)
def delete_deadline(org_id: uuid.UUID, deadline_id: uuid.UUID, ctx: CanWrite, bg: BackgroundTasks) -> None:
    d = ctx.db.get(Deadline, deadline_id)
    if d is None:
        raise not_found("Deadline")
    if d.source == "notice":
        raise ApiError(409, "deadline_from_notice", "The notice's own deadline cannot be deleted")
    opp = ctx.db.get(Opportunity, d.opportunity_id)
    ctx.db.delete(d)
    write_audit(
        ctx.db,
        org_id,
        actor_type="human",
        actor_id=str(ctx.user_id),
        action="deadline.deleted",
        entity_type="deadline",
        entity_id=deadline_id,
        before={"kind": d.kind, "due_at": d.due_at.isoformat()},
    )
    bg.add_task(runtime.notify_opportunity, opp.workflow_id if opp else None, "deadlines_changed")


@router.get(
    "/deadlines", response_model=list[DeadlineOut], summary="Upcoming deadlines and reminders across opportunities"
)
def upcoming(org_id: uuid.UUID, ctx: CanRead, within_days: int = 30, include_fired: bool = False) -> list[Deadline]:
    stmt = select(Deadline).where(Deadline.due_at <= datetime.now(UTC) + timedelta(days=max(1, min(within_days, 365))))
    if not include_fired:
        stmt = stmt.where(Deadline.fired_at.is_(None))
    return list(ctx.db.scalars(stmt.order_by(Deadline.due_at).limit(500)))


_ = snapshot  # exported for tests
