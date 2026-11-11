"""Agent proposals and the human approval flow. The agent writes proposals; only a person can approve them."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select

from tenderline.agent.schema import validate_payload
from tenderline.api.deps import CanDecide, CanRead, IdempotencyKeyHeader, TenantContext, run_idempotent
from tenderline.audit import write_audit
from tenderline.errors import ApiError, body, not_found
from tenderline.models import AgentProposal, Approval, Notice
from tenderline.observability import current_traceparent
from tenderline.pagination import paginate
from tenderline.workflows import runtime

router = APIRouter(prefix="/v1/organisations/{org_id}/agent-proposals", tags=["agent proposals"])


class ApprovalOut(BaseModel):
    decision: str
    decided_by: uuid.UUID
    edited_payload: dict[str, Any] | None
    reason: str | None
    created_at: datetime


class ProposalOut(BaseModel):
    id: uuid.UUID
    match_id: uuid.UUID | None
    notice_id: uuid.UUID
    notice_version: int
    action_type: str
    payload: dict[str, Any]
    rationale: str | None
    fit_score: int | None
    status: str
    result: dict[str, Any] | None
    created_at: datetime
    decided_at: datetime | None
    executed_at: datetime | None
    approval: ApprovalOut | None = None


class ProposalPage(BaseModel):
    items: list[ProposalOut]
    next_cursor: str | None


class ApproveIn(BaseModel):
    comment: str | None = Field(default=None, max_length=1000)


class EditApproveIn(BaseModel):
    payload: dict[str, Any]
    comment: str | None = Field(default=None, max_length=1000)


class RejectIn(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)


def _out_many(db: Any, proposals: list[AgentProposal]) -> list[ProposalOut]:
    """Serialise proposals with their approvals using one extra query, not one per row."""
    ids = [p.id for p in proposals]
    approvals = (
        {a.proposal_id: a for a in db.scalars(select(Approval).where(Approval.proposal_id.in_(ids)))} if ids else {}
    )
    out = []
    for p in proposals:
        item = ProposalOut.model_validate(p, from_attributes=True)
        a = approvals.get(p.id)
        if a is not None:
            item.approval = ApprovalOut(
                decision=a.decision,
                decided_by=a.decided_by,
                edited_payload=a.edited_payload,
                reason=a.reason,
                created_at=a.created_at,
            )
        out.append(item)
    return out


def _out(db: Any, p: AgentProposal) -> ProposalOut:
    return _out_many(db, [p])[0]


@router.get("", response_model=ProposalPage, summary="List proposals (newest first)")
def list_proposals(
    org_id: uuid.UUID,
    ctx: CanRead,
    status: str | None = None,
    notice_id: uuid.UUID | None = None,
    match_id: uuid.UUID | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> ProposalPage:
    stmt = select(AgentProposal)
    if status:
        stmt = stmt.where(AgentProposal.status == status)
    if notice_id:
        stmt = stmt.where(AgentProposal.notice_id == notice_id)
    if match_id:
        stmt = stmt.where(AgentProposal.match_id == match_id)
    rows, nxt = paginate(ctx.db, stmt, AgentProposal.created_at, AgentProposal.id, cursor, limit)
    return ProposalPage(items=_out_many(ctx.db, rows), next_cursor=nxt)


@router.get("/{proposal_id}", response_model=ProposalOut)
def get_proposal(org_id: uuid.UUID, proposal_id: uuid.UUID, ctx: CanRead) -> ProposalOut:
    p = ctx.db.get(AgentProposal, proposal_id)
    if p is None:
        raise not_found("Proposal")
    return _out(ctx.db, p)


def _decide(
    ctx: TenantContext,
    org_id: uuid.UUID,
    proposal_id: uuid.UUID,
    key: str,
    payload: Any,
    bg: BackgroundTasks,
    decision: str,
    edited: dict[str, Any] | None = None,
    reason: str | None = None,
) -> JSONResponse:
    def run() -> tuple[int, Any]:
        p = ctx.db.execute(
            select(AgentProposal).where(AgentProposal.id == proposal_id).with_for_update()
        ).scalar_one_or_none()
        if p is None:
            raise not_found("Proposal")
        notice = ctx.db.get(Notice, p.notice_id)
        if p.status == "pending" and notice is not None and notice.current_version > p.notice_version:
            # A corrigendum landed after this proposal was made and before its cancellation ran.
            p.status = "cancelled"
            write_audit(
                ctx.db,
                org_id,
                actor_type="agent",
                actor_id="corrigendum-handler",
                action="proposal.cancelled",
                entity_type="agent_proposal",
                entity_id=p.id,
                after={"reason": "notice corrected", "new_version": notice.current_version},
            )
            return 409, body(
                "proposal_stale",
                "The notice was corrected after this proposal was made; it was cancelled",
                {"proposal_version": p.notice_version, "notice_version": notice.current_version},
            )
        if p.status == "cancelled":
            return 409, body("proposal_cancelled", "This proposal was cancelled (the notice changed or was awarded)")
        if p.status != "pending":
            return 409, body("already_decided", f"This proposal is already {p.status}", {"status": p.status})
        final_payload = None
        if edited is not None:
            try:
                final_payload = validate_payload(p.action_type, edited)
            except ValidationError as exc:
                return 422, body(
                    "invalid_payload",
                    "Edited payload does not match the action's schema",
                    jsonable_encoder(exc.errors(include_url=False, include_context=False)),
                )
        before = {"status": p.status, "payload": p.payload}
        p.status = "rejected" if decision == "rejected" else "approved"
        p.decided_at = datetime.now(UTC)
        ctx.db.add(
            Approval(
                organisation_id=org_id,
                proposal_id=p.id,
                decision=decision,
                decided_by=ctx.user_id,
                edited_payload=final_payload,
                reason=reason,
            )
        )
        ctx.db.flush()
        write_audit(
            ctx.db,
            org_id,
            actor_type="human",
            actor_id=str(ctx.user_id),
            action=f"proposal.{decision}",
            entity_type="agent_proposal",
            entity_id=p.id,
            before=before,
            after={"status": p.status, "edited_payload": final_payload, "reason": reason},
        )
        return 200, _out(ctx.db, p)

    resp = run_idempotent(ctx.db, org_id, key, payload, run)
    if resp.status_code == 200 and decision != "rejected" and "idempotent-replay" not in resp.headers:
        # Start only after this transaction commits (background tasks run after the response). If the process
        # dies in between, the reconciler workflow restarts the execution: workflow id == proposal id.
        bg.add_task(runtime.start_execution, org_id, proposal_id, current_traceparent())
    return resp


@router.post("/{proposal_id}/approve", response_model=ProposalOut, summary="Approve exactly as proposed")
def approve(
    org_id: uuid.UUID,
    proposal_id: uuid.UUID,
    payload: ApproveIn,
    ctx: CanDecide,
    key: IdempotencyKeyHeader,
    bg: BackgroundTasks,
) -> JSONResponse:
    return _decide(
        ctx,
        org_id,
        proposal_id,
        key,
        {"id": str(proposal_id), "op": "approve", **payload.model_dump()},
        bg,
        "approved",
        reason=payload.comment,
    )


@router.post("/{proposal_id}/edit-approve", response_model=ProposalOut, summary="Edit the payload, then approve")
def edit_approve(
    org_id: uuid.UUID,
    proposal_id: uuid.UUID,
    payload: EditApproveIn,
    ctx: CanDecide,
    key: IdempotencyKeyHeader,
    bg: BackgroundTasks,
) -> JSONResponse:
    return _decide(
        ctx,
        org_id,
        proposal_id,
        key,
        {"id": str(proposal_id), "op": "edit", **payload.model_dump()},
        bg,
        "edited",
        edited=payload.payload,
        reason=payload.comment,
    )


@router.post("/{proposal_id}/reject", response_model=ProposalOut, summary="Reject (a reason is required)")
def reject(
    org_id: uuid.UUID,
    proposal_id: uuid.UUID,
    payload: RejectIn,
    ctx: CanDecide,
    key: IdempotencyKeyHeader,
    bg: BackgroundTasks,
) -> JSONResponse:
    return _decide(
        ctx,
        org_id,
        proposal_id,
        key,
        {"id": str(proposal_id), "op": "reject", **payload.model_dump()},
        bg,
        "rejected",
        reason=payload.reason,
    )


_ = ApiError  # re-exported for callers that catch it alongside this router
