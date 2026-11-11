"""Persist parsed notices: versioned upserts (history is never overwritten), buyers, CPV codes, awards."""

from __future__ import annotations

import logging
import re
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Literal

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from tenderline.db import public_session
from tenderline.models import Buyer, CpvCode, IngestionRun, Lot, Notice, NoticeCpv, NoticeVersion
from tenderline.ted.parse import ParsedNotice, parse_ted_notice

log = logging.getLogger(__name__)

Action = Literal["new", "updated", "unchanged"]
DIFF_FIELDS = (
    "title",
    "notice_type",
    "buyer_name",
    "deadline_at",
    "estimated_value",
    "currency",
    "cpv_codes",
    "summary",
)


@dataclass
class StoreResult:
    notice_id: uuid.UUID
    action: Action
    version: int
    kind: str
    changes: dict[str, dict[str, Any]] = field(default_factory=dict)
    awarded_notice_ids: list[uuid.UUID] = field(default_factory=list)

    def event(self) -> dict[str, Any]:
        return {
            "notice_id": str(self.notice_id),
            "action": self.action,
            "version": self.version,
            "kind": self.kind,
            "changes": self.changes,
            "awarded_notice_ids": [str(i) for i in self.awarded_notice_ids],
        }


def normalise_name(name: str) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().casefold()
    text = re.sub(r"\b(ltd|limited|plc|dac|clg|teoranta|t/a)\b\.?", "", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _buyer_id(db: Session, name: str | None, country: str | None) -> uuid.UUID | None:
    if not name:
        return None
    norm = normalise_name(name)
    if not norm:
        return None
    stmt = (
        pg_insert(Buyer)
        .values(name=name[:400], normalised_name=norm, country=country)
        .on_conflict_do_nothing(index_elements=["normalised_name", "country"])
        .returning(Buyer.id)
    )
    got = db.execute(stmt).scalar()
    if got:
        return got
    return db.scalars(
        select(Buyer.id).where(
            Buyer.normalised_name == norm,
            Buyer.country.is_(country) if country is None else Buyer.country == country,
        )
    ).one()


def _diff(old: dict[str, Any], new: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {k: {"old": old.get(k), "new": new.get(k)} for k in DIFF_FIELDS if old.get(k) != new.get(k)}


def _apply_to_notice(db: Session, notice: Notice, p: ParsedNotice, version: int) -> None:
    notice.notice_type = p.notice_type
    notice.procedure_id = p.procedure_id
    notice.current_version = version
    notice.title = p.title
    notice.summary = p.summary
    notice.buyer_id = _buyer_id(db, p.buyer_name, p.country)
    notice.country = p.country
    notice.publication_date = p.publication_date
    notice.deadline_at = p.deadline_at
    notice.estimated_value = p.estimated_value
    notice.currency = p.currency
    notice.source_url = p.source_url
    if p.award is not None:
        notice.status = "awarded"
        notice.award = p.award
    if p.status:
        notice.status = p.status
    notice.updated_at = datetime.now(UTC)
    db.flush()
    # CPV codes + lots reflect the current version (history lives in notice_versions.fields).
    db.execute(delete(NoticeCpv).where(NoticeCpv.notice_id == notice.id))
    for i, code in enumerate(p.cpv_codes):
        db.execute(
            pg_insert(CpvCode).values(code=code, division=code[:2]).on_conflict_do_nothing(index_elements=["code"])
        )
        db.add(NoticeCpv(notice_id=notice.id, cpv_code=code, is_main=i == 0))
    for lot in p.lots:
        db.add(
            Lot(
                notice_id=notice.id,
                version=version,
                position=lot["position"],
                estimated_value=lot["estimated_value"],
                deadline_at=datetime.fromisoformat(lot["deadline_at"]) if lot["deadline_at"] else None,
            )
        )
    db.flush()


def _find_existing(db: Session, p: ParsedNotice) -> Notice | None:
    conds = [Notice.source_id == p.source_id]
    stmt = select(Notice).where(Notice.source == p.source)
    if p.notice_identifier:
        ids = select(NoticeVersion.notice_id).where(
            NoticeVersion.fields["notice_identifier"].astext == p.notice_identifier
        )
        conds.append(Notice.id.in_(ids))
    return db.scalars(stmt.where(or_(*conds))).first()


def store_notice(db: Session, p: ParsedNotice) -> StoreResult:
    existing = _find_existing(db, p)
    snapshot = p.snapshot()
    if existing is None:
        notice = Notice(
            source=p.source, source_id=p.source_id, notice_type=p.notice_type, title=p.title, current_version=1
        )
        db.add(notice)
        db.flush()
        _apply_to_notice(db, notice, p, 1)
        db.add(NoticeVersion(notice_id=notice.id, version=1, content_hash=p.content_hash, raw=p.raw, fields=snapshot))
        db.flush()
        result = StoreResult(notice.id, "new", 1, p.kind)
    else:
        seen = db.scalar(
            select(func.count())
            .select_from(NoticeVersion)
            .where(NoticeVersion.notice_id == existing.id, NoticeVersion.content_hash == p.content_hash)
        )
        if seen:
            return StoreResult(existing.id, "unchanged", existing.current_version, p.kind)
        latest = db.scalars(
            select(NoticeVersion).where(NoticeVersion.notice_id == existing.id).order_by(NoticeVersion.version.desc())
        ).first()
        assert latest is not None
        version = latest.version + 1
        changes = _diff(latest.fields, snapshot)
        db.add(
            NoticeVersion(
                notice_id=existing.id,
                version=version,
                content_hash=p.content_hash,
                raw=p.raw,
                fields=snapshot,
                changes=changes,
            )
        )
        _apply_to_notice(db, existing, p, version)
        result = StoreResult(existing.id, "updated", version, p.kind, changes)
    if p.kind == "award" and p.procedure_id:
        result.awarded_notice_ids = _close_related_calls(db, p, result.notice_id)
    return result


def _close_related_calls(db: Session, p: ParsedNotice, award_notice_id: uuid.UUID) -> list[uuid.UUID]:
    """An award notice shares its procedure id with the call: mark the call awarded."""
    rows = db.execute(
        update(Notice)
        .where(
            Notice.source == p.source,
            Notice.procedure_id == p.procedure_id,
            Notice.id != award_notice_id,
            Notice.notice_type.like("cn-%"),
            Notice.status == "open",
        )
        .values(status="awarded", award=p.award, updated_at=datetime.now(UTC))
        .returning(Notice.id)
    ).all()
    return [r[0] for r in rows]


# ------------------------------------------------------------------ ingestion runs
def start_run(source: str, window_from: date, workflow_id: str | None = None) -> uuid.UUID:
    with public_session() as db:
        run = IngestionRun(source=source, window_from=window_from, workflow_id=workflow_id)
        db.add(run)
        db.flush()
        return run.id


def ingest_batch(
    run_id: uuid.UUID, raw_notices: list[dict[str, Any]], next_token: str | None, page_no: int, query: str
) -> list[dict[str, Any]]:
    """Parse and store one page, and advance the run cursor, in a single transaction.

    Because the cursor moves atomically with the data and stores are idempotent (content hash), re-running
    a page after a crash can never duplicate or lose a notice.
    """
    events: list[dict[str, Any]] = []
    new = updated = bad = 0
    with public_session() as db:
        for raw in raw_notices:
            try:
                parsed = parse_ted_notice(raw)
            except (ValueError, KeyError, TypeError):
                bad += 1
                log.warning("skipping unparseable TED notice %s", raw.get("publication-number"))
                continue
            res = store_notice(db, parsed)
            new += res.action == "new"
            updated += res.action == "updated"
            if res.action != "unchanged" or res.awarded_notice_ids:
                events.append(res.event())
        db.execute(
            update(IngestionRun)
            .where(IngestionRun.id == run_id)
            .values(
                notices_seen=IngestionRun.notices_seen + len(raw_notices),
                notices_new=IngestionRun.notices_new + new,
                notices_updated=IngestionRun.notices_updated + updated,
                cursor={"token": next_token, "page": page_no, "query": query},
            )
        )
    return events


def finish_run(run_id: uuid.UUID, status: str, error: str | None = None) -> None:
    with public_session() as db:
        db.execute(
            update(IngestionRun)
            .where(IngestionRun.id == run_id)
            .values(status=status, error=error, finished_at=datetime.now(UTC))
        )


def last_cursor(source: str) -> dict[str, Any] | None:
    """Latest unfinished run's cursor (resume point), if any."""
    with public_session() as db:
        run = db.scalars(
            select(IngestionRun)
            .where(IngestionRun.source == source, IngestionRun.status == "running")
            .order_by(IngestionRun.started_at.desc())
        ).first()
        return None if run is None else {"run_id": str(run.id), "cursor": run.cursor, "window_from": run.window_from}


def last_success_date(source: str) -> date | None:
    with public_session() as db:
        result: date | None = db.scalar(
            select(func.max(func.date(IngestionRun.finished_at))).where(
                IngestionRun.source == source, IngestionRun.status == "ok"
            )
        )
        return result
