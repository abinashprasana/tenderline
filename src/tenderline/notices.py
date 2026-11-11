"""Store parsed notices. A notice keeps every version it has ever had; nothing is overwritten."""

from __future__ import annotations

import logging
import re
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Literal

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
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
        """The JSON-safe form handed to the notice-event workflow."""
        return {
            "notice_id": str(self.notice_id),
            "action": self.action,
            "version": self.version,
            "kind": self.kind,
            "changes": self.changes,
            "awarded_notice_ids": [str(notice_id) for notice_id in self.awarded_notice_ids],
        }


def normalise_name(name: str) -> str:
    """Lower-case, strip accents, punctuation and company suffixes, so "Acme Ltd." equals "ACME LIMITED"."""
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().casefold()
    text = re.sub(r"\b(ltd|limited|plc|dac|clg|teoranta|t/a)\b\.?", "", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _get_or_create_buyer(db: Session, name: str | None, country: str | None) -> uuid.UUID | None:
    if not name:
        return None
    normalised = normalise_name(name)
    if not normalised:
        return None
    insert = (
        pg_insert(Buyer)
        .values(name=name[:400], normalised_name=normalised, country=country)
        .on_conflict_do_nothing(index_elements=["normalised_name", "country"])
        .returning(Buyer.id)
    )
    buyer_id = db.execute(insert).scalar()
    if buyer_id:
        return buyer_id
    return db.scalars(
        select(Buyer.id).where(
            Buyer.normalised_name == normalised,
            Buyer.country.is_(country) if country is None else Buyer.country == country,
        )
    ).one()


def _changed_fields(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        name: {"old": previous.get(name), "new": current.get(name)}
        for name in DIFF_FIELDS
        if previous.get(name) != current.get(name)
    }


def _apply_to_notice(db: Session, notice: Notice, parsed: ParsedNotice, version: int) -> None:
    """Copy the newest version's fields onto the notice row, and replace its CPV codes and lots."""
    notice.notice_type = parsed.notice_type
    notice.procedure_id = parsed.procedure_id
    notice.current_version = version
    notice.title = parsed.title
    notice.summary = parsed.summary
    notice.buyer_id = _get_or_create_buyer(db, parsed.buyer_name, parsed.country)
    notice.country = parsed.country
    notice.publication_date = parsed.publication_date
    notice.deadline_at = parsed.deadline_at
    notice.estimated_value = parsed.estimated_value
    notice.currency = parsed.currency
    notice.source_url = parsed.source_url
    if parsed.award is not None:
        notice.status = "awarded"
        notice.award = parsed.award
    if parsed.status:
        notice.status = parsed.status
    notice.updated_at = datetime.now(UTC)
    db.flush()
    db.execute(delete(NoticeCpv).where(NoticeCpv.notice_id == notice.id))
    for position, code in enumerate(parsed.cpv_codes):
        db.execute(
            pg_insert(CpvCode).values(code=code, division=code[:2]).on_conflict_do_nothing(index_elements=["code"])
        )
        db.add(NoticeCpv(notice_id=notice.id, cpv_code=code, is_main=position == 0))
    for lot in parsed.lots:
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


def _version_field(name: str) -> Any:
    """`notice_versions.fields ->> name`, written the way the expression indexes are, so they get used."""
    return NoticeVersion.fields[name].astext


def _notice_with_version_field(db: Session, source: str, field_name: str, value: str) -> Notice | None:
    notice_id = db.scalar(
        select(NoticeVersion.notice_id)
        .join(Notice, Notice.id == NoticeVersion.notice_id)
        .where(Notice.source == source, _version_field(field_name) == value)
        .order_by(NoticeVersion.version.desc())
        .limit(1)
    )
    return db.get(Notice, notice_id) if notice_id else None


def _find_stored_notice(db: Session, parsed: ParsedNotice) -> tuple[Notice | None, bool]:
    """Find the notice this publication belongs to. Returns (notice, superseded).

    TED publishes a correction as a separate notice with its own publication number and identifier, which names
    the notice it corrects. So a publication belongs to a stored notice when, in this order:
      1. it has the same publication number (a re-ingest), or
      2. a stored version carries its identifier, or
      3. it is a change notice and a stored version carries the identifier it corrects.
    `superseded` is True when we already hold a change notice that corrects this publication: the text arriving
    now is the older one and must not be stored on top of the newer.
    """
    notice = db.scalars(
        select(Notice).where(Notice.source == parsed.source, Notice.source_id == parsed.source_id)
    ).first()
    if notice is not None:
        return notice, False
    for identifier in (parsed.notice_identifier, parsed.changed_notice_identifier):
        if identifier:
            notice = _notice_with_version_field(db, parsed.source, "notice_identifier", identifier)
            if notice is not None:
                return notice, False
    if parsed.notice_identifier:
        notice = _notice_with_version_field(db, parsed.source, "changed_notice_identifier", parsed.notice_identifier)
        if notice is not None:
            return notice, True
    return None, False


def store_notice(db: Session, parsed: ParsedNotice) -> StoreResult:
    """Store a publication as a new notice, a new version of a known notice, or nothing if we already have it."""
    notice, superseded = _find_stored_notice(db, parsed)
    snapshot = parsed.snapshot()
    if notice is None:
        notice = Notice(
            source=parsed.source,
            source_id=parsed.source_id,
            notice_type=parsed.notice_type,
            title=parsed.title,
            current_version=1,
        )
        db.add(notice)
        db.flush()
        _apply_to_notice(db, notice, parsed, 1)
        db.add(
            NoticeVersion(
                notice_id=notice.id, version=1, content_hash=parsed.content_hash, raw=parsed.raw, fields=snapshot
            )
        )
        db.flush()
        result = StoreResult(notice.id, "new", 1, parsed.kind)
    else:
        if superseded:
            return StoreResult(notice.id, "unchanged", notice.current_version, parsed.kind)
        # "Already stored" means the newest version we hold of THIS publication has the same content. Comparing
        # with every older version would hide a real change back to earlier wording; comparing with the newest
        # version overall would turn the daily re-read of an old publication into a bogus new version.
        same_publication = db.scalars(
            select(NoticeVersion)
            .where(NoticeVersion.notice_id == notice.id, _version_field("publication_number") == parsed.source_id)
            .order_by(NoticeVersion.version.desc())
            .limit(1)
        ).first()
        if same_publication is not None and same_publication.content_hash == parsed.content_hash:
            return StoreResult(notice.id, "unchanged", notice.current_version, parsed.kind)
        latest = db.scalars(
            select(NoticeVersion)
            .where(NoticeVersion.notice_id == notice.id)
            .order_by(NoticeVersion.version.desc())
            .limit(1)
        ).one()
        version = latest.version + 1
        changes = _changed_fields(latest.fields, snapshot)
        db.add(
            NoticeVersion(
                notice_id=notice.id,
                version=version,
                content_hash=parsed.content_hash,
                raw=parsed.raw,
                fields=snapshot,
                changes=changes,
            )
        )
        _apply_to_notice(db, notice, parsed, version)
        result = StoreResult(notice.id, "updated", version, parsed.kind, changes)
    if parsed.kind == "award" and parsed.procedure_id:
        result.awarded_notice_ids = _mark_calls_awarded(db, parsed, result.notice_id)
    return result


def _mark_calls_awarded(db: Session, award: ParsedNotice, award_notice_id: uuid.UUID) -> list[uuid.UUID]:
    """An award notice shares its procedure id with the call for tenders: mark those calls awarded."""
    rows = db.execute(
        update(Notice)
        .where(
            Notice.source == award.source,
            Notice.procedure_id == award.procedure_id,
            Notice.id != award_notice_id,
            Notice.notice_type.like("cn-%"),
            Notice.status == "open",
        )
        .values(status="awarded", award=award.award, updated_at=datetime.now(UTC))
        .returning(Notice.id)
    ).all()
    return [row[0] for row in rows]


# ------------------------------------------------------------------ ingestion runs
def start_run(source: str, window_from: date, workflow_id: str | None = None) -> uuid.UUID:
    """Open a new ingestion run.

    Any run still marked running at this point died without a cursor to resume from (the caller resumes the ones
    that have one), so it is closed as abandoned instead of being left running forever.
    """
    with public_session() as db:
        db.execute(
            update(IngestionRun)
            .where(IngestionRun.source == source, IngestionRun.status == "running")
            .values(status="abandoned", finished_at=datetime.now(UTC))
        )
        run = IngestionRun(source=source, window_from=window_from, workflow_id=workflow_id)
        db.add(run)
        db.flush()
        return run.id


def ingest_batch(
    run_id: uuid.UUID, raw_notices: list[dict[str, Any]], next_token: str | None, page_no: int, query: str
) -> list[dict[str, Any]]:
    """Parse and store one page and advance the run cursor, all in one transaction.

    The cursor moves with the data, and storing is idempotent, so re-running a page after a crash neither
    duplicates nor loses a notice. Each notice gets its own savepoint: one that cannot be parsed or stored is
    counted and skipped, so a single bad record cannot block the page (and with it the whole run) forever.
    """
    events: list[dict[str, Any]] = []
    new = updated = skipped = 0
    with public_session() as db:
        for raw in raw_notices:
            try:
                parsed = parse_ted_notice(raw)
                with db.begin_nested():
                    stored = store_notice(db, parsed)
            except (ValueError, KeyError, TypeError, SQLAlchemyError) as exc:
                skipped += 1
                log.warning("skipping TED notice %s: %s", raw.get("publication-number"), type(exc).__name__)
                continue
            new += stored.action == "new"
            updated += stored.action == "updated"
            if stored.action != "unchanged" or stored.awarded_notice_ids:
                events.append(stored.event())
        db.execute(
            update(IngestionRun)
            .where(IngestionRun.id == run_id)
            .values(
                notices_seen=IngestionRun.notices_seen + len(raw_notices),
                notices_new=IngestionRun.notices_new + new,
                notices_updated=IngestionRun.notices_updated + updated,
                notices_skipped=IngestionRun.notices_skipped + skipped,
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
    """The newest unfinished run and its cursor, which is where ingestion resumes from. None if there is none."""
    with public_session() as db:
        run = db.scalars(
            select(IngestionRun)
            .where(IngestionRun.source == source, IngestionRun.status == "running")
            .order_by(IngestionRun.started_at.desc())
        ).first()
        return None if run is None else {"run_id": str(run.id), "cursor": run.cursor, "window_from": run.window_from}


def last_success_date(source: str) -> date | None:
    with public_session() as db:
        finished_on: date | None = db.scalar(
            select(func.max(func.date(IngestionRun.finished_at))).where(
                IngestionRun.source == source, IngestionRun.status == "ok"
            )
        )
        return finished_on
