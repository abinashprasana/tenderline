"""Everything the overview screen shows, in one request."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import distinct, func, select, tuple_

from tenderline.api.deps import CanRead
from tenderline.api.routers.notices import RunOut
from tenderline.db import public_session
from tenderline.models import AgentProposal, Approval, Deadline, IngestionRun, Match, Notice, Opportunity, Organisation
from tenderline.opportunities import CLOSED, STATUSES

router = APIRouter(prefix="/v1/organisations/{org_id}", tags=["summary"])

FIT_BUCKETS = list(range(0, 100, 10))  # 0-9, 10-19, ... 90-100


class FitBucket(BaseModel):
    lower: int
    upper: int
    notices: int


class SummaryOut(BaseModel):
    proposals_pending: int
    notices_awaiting_decision: int
    matches_awaiting_assessment: int
    decisions_today: int
    decisions_last_7_days: int
    opportunities_open: int
    opportunities_by_status: dict[str, int]
    deadlines_next_7_days: int
    deadlines_next_30_days: int
    fit_score_histogram: list[FitBucket]
    notices_ingested_24h: int
    last_ingestion: RunOut | None
    generated_at: datetime


@router.get("/summary", response_model=SummaryOut, summary="Counts for the overview dashboard")
def organisation_summary(org_id: uuid.UUID, ctx: CanRead) -> SummaryOut:
    now = datetime.now(UTC)
    db = ctx.db
    pending = select(AgentProposal).where(AgentProposal.status == "pending").subquery()
    proposals_pending = int(db.scalar(select(func.count()).select_from(pending)) or 0)
    notices_awaiting = int(
        db.scalar(select(func.count(distinct(tuple_(pending.c.notice_id, pending.c.notice_version))))) or 0
    )

    matches_awaiting = int(db.scalar(select(func.count()).select_from(Match).where(Match.qualified_at.is_(None))) or 0)
    # "Today" starts at midnight in the organisation's timezone (UTC when none is set).
    organisation = db.get(Organisation, org_id)
    try:
        zone = ZoneInfo(organisation.timezone) if organisation and organisation.timezone else UTC
    except (ZoneInfoNotFoundError, ValueError):
        zone = UTC
    midnight = now.astimezone(zone).replace(hour=0, minute=0, second=0, microsecond=0)

    def decisions_since(moment: datetime) -> int:
        return int(db.scalar(select(func.count()).select_from(Approval).where(Approval.created_at >= moment)) or 0)

    by_status = dict.fromkeys(STATUSES, 0)
    for status, count in db.execute(select(Opportunity.status, func.count()).group_by(Opportunity.status)):
        by_status[status] = int(count)

    def unfired_deadlines_within(days: int) -> int:
        return int(
            db.scalar(
                select(func.count())
                .select_from(Deadline)
                .where(
                    Deadline.fired_at.is_(None), Deadline.due_at >= now, Deadline.due_at <= now + timedelta(days=days)
                )
            )
            or 0
        )

    # The fit score is the same on every action proposed for one notice version, so count notices, not actions.
    per_notice = (
        select(pending.c.notice_id, pending.c.notice_version, func.max(pending.c.fit_score).label("fit"))
        .group_by(pending.c.notice_id, pending.c.notice_version)
        .subquery()
    )
    bucket_counts = dict.fromkeys(FIT_BUCKETS, 0)
    for (fit,) in db.execute(select(per_notice.c.fit).where(per_notice.c.fit.is_not(None))):
        bucket_counts[min(int(fit) // 10 * 10, 90)] += 1
    histogram = [
        FitBucket(lower=lower, upper=100 if lower == 90 else lower + 9, notices=count)
        for lower, count in bucket_counts.items()
    ]

    with public_session() as shared:
        ingested = int(
            shared.scalar(
                select(func.count()).select_from(Notice).where(Notice.created_at >= now - timedelta(hours=24))
            )
            or 0
        )
        last_run = shared.scalars(select(IngestionRun).order_by(IngestionRun.started_at.desc()).limit(1)).first()
        last_ingestion = RunOut.model_validate(last_run) if last_run else None

    return SummaryOut(
        proposals_pending=proposals_pending,
        notices_awaiting_decision=notices_awaiting,
        matches_awaiting_assessment=matches_awaiting,
        decisions_today=decisions_since(midnight),
        decisions_last_7_days=decisions_since(now - timedelta(days=7)),
        opportunities_open=sum(count for status, count in by_status.items() if status not in CLOSED),
        opportunities_by_status=by_status,
        deadlines_next_7_days=unfired_deadlines_within(7),
        deadlines_next_30_days=unfired_deadlines_within(30),
        fit_score_histogram=histogram,
        notices_ingested_24h=ingested,
        last_ingestion=last_ingestion,
        generated_at=now,
    )
