"""Match notices against saved searches.

Semantics: criteria of different kinds are ANDed; values inside one criterion are ORed. An empty criterion
is ignored. CPV codes match hierarchically (72000000 covers every 72xxxxxx code). A notice whose value is
unknown is not excluded by a value range, but the match records `value_unknown` so a human can see why.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select, update

from tenderline.audit import write_audit
from tenderline.db import list_org_ids, public_session, tenant_session
from tenderline.models import Buyer, Match, Notice, NoticeCpv, SavedSearch
from tenderline.notices import normalise_name


@dataclass(frozen=True)
class NoticeView:
    id: uuid.UUID
    version: int
    kind: str
    status: str
    title: str
    summary: str | None
    buyer_name: str | None
    country: str | None
    cpv_codes: tuple[str, ...]
    value: Decimal | None
    deadline_at: datetime | None


@dataclass(frozen=True)
class SearchView:
    id: uuid.UUID
    cpv_codes: tuple[str, ...]
    buyer_names: tuple[str, ...]
    keywords: tuple[str, ...]
    countries: tuple[str, ...]
    min_value: Decimal | None
    max_value: Decimal | None


def cpv_prefix(code: str) -> str:
    """CPV hierarchy: trailing zeros are wildcards, but a code is never shorter than its 2-digit division
    (45000000 -> '45', 45210000 -> '4521', 30000000 -> '30', never '3')."""
    padded = code.ljust(8, "0")[:8]
    stripped = padded.rstrip("0")
    return stripped if len(stripped) >= 2 else padded[:2]


def is_open_call(n: NoticeView, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    return n.kind == "call" and n.status == "open" and (n.deadline_at is None or n.deadline_at > now)


def evaluate(n: NoticeView, s: SearchView) -> dict[str, Any] | None:
    """Return the reasons a notice matches a search, or None when it does not."""
    reasons: dict[str, Any] = {}
    if s.countries:
        if not n.country or n.country.upper() not in {c.upper() for c in s.countries}:
            return None
        reasons["country"] = n.country
    if s.cpv_codes:
        hit = sorted(
            {c for c in n.cpv_codes for p in s.cpv_codes if c.startswith(cpv_prefix(p))},
        )
        if not hit:
            return None
        reasons["cpv"] = hit[:10]
    if s.buyer_names:
        nb = normalise_name(n.buyer_name or "")
        hit_b = [b for b in s.buyer_names if normalise_name(b) and normalise_name(b) in nb]
        if not hit_b:
            return None
        reasons["buyer"] = hit_b
    if s.keywords:
        haystack = f"{n.title} {n.summary or ''}".casefold()
        hit_k = [k for k in s.keywords if re.search(rf"\b{re.escape(k.casefold())}", haystack)]
        if not hit_k:
            return None
        reasons["keywords"] = hit_k
    if s.min_value is not None or s.max_value is not None:
        if n.value is None:
            reasons["value_unknown"] = True
        else:
            if s.min_value is not None and n.value < s.min_value:
                return None
            if s.max_value is not None and n.value > s.max_value:
                return None
            reasons["value"] = str(n.value)
    return reasons


def load_notice_view(notice_id: uuid.UUID) -> NoticeView | None:
    from tenderline.ted.parse import notice_kind

    with public_session() as db:
        n = db.get(Notice, notice_id)
        if n is None:
            return None
        cpvs = tuple(
            db.scalars(select(NoticeCpv.cpv_code).where(NoticeCpv.notice_id == n.id).order_by(NoticeCpv.cpv_code))
        )
        buyer = db.get(Buyer, n.buyer_id).name if n.buyer_id else None  # type: ignore[union-attr]
        return NoticeView(
            id=n.id,
            version=n.current_version,
            kind=notice_kind(n.notice_type),
            status=n.status,
            title=n.title,
            summary=n.summary,
            buyer_name=buyer,
            country=n.country,
            cpv_codes=cpvs,
            value=n.estimated_value,
            deadline_at=n.deadline_at,
        )


def _search_view(s: SavedSearch) -> SearchView:
    return SearchView(
        s.id, tuple(s.cpv_codes), tuple(s.buyer_names), tuple(s.keywords), tuple(s.countries), s.min_value, s.max_value
    )


def match_notice_for_org(org_id: uuid.UUID, n: NoticeView) -> list[uuid.UUID]:
    """Create (or refresh) matches for one organisation. Returns ids of matches needing (re)qualification."""
    if not is_open_call(n):
        return []
    needs_work: list[uuid.UUID] = []
    with tenant_session(org_id) as db:
        searches = db.scalars(select(SavedSearch).where(SavedSearch.active.is_(True))).all()
        for s in searches:
            reasons = evaluate(n, _search_view(s))
            if reasons is None:
                continue
            existing = db.scalars(select(Match).where(Match.saved_search_id == s.id, Match.notice_id == n.id)).first()
            if existing is None:
                m = Match(
                    organisation_id=org_id,
                    saved_search_id=s.id,
                    notice_id=n.id,
                    notice_version=n.version,
                    reasons=reasons,
                )
                db.add(m)
                db.flush()
                write_audit(
                    db,
                    org_id,
                    actor_type="agent",
                    actor_id="matcher-v1",
                    action="match.created",
                    entity_type="match",
                    entity_id=m.id,
                    after={"notice_id": str(n.id), "saved_search_id": str(s.id), "reasons": reasons},
                )
                needs_work.append(m.id)
            elif existing.notice_version != n.version:
                db.execute(
                    update(Match)
                    .where(Match.id == existing.id)
                    .values(notice_version=n.version, reasons=reasons, qualified_at=None)
                )
                write_audit(
                    db,
                    org_id,
                    actor_type="agent",
                    actor_id="matcher-v1",
                    action="match.refreshed",
                    entity_type="match",
                    entity_id=existing.id,
                    before={"notice_version": existing.notice_version},
                    after={"notice_version": n.version},
                )
                needs_work.append(existing.id)
    return needs_work


def match_notice(notice_id: uuid.UUID) -> list[tuple[uuid.UUID, uuid.UUID]]:
    """Match one notice against every organisation. Returns (org_id, match_id) pairs needing qualification."""
    n = load_notice_view(notice_id)
    if n is None:
        return []
    out: list[tuple[uuid.UUID, uuid.UUID]] = []
    for org_id in list_org_ids():
        out.extend((org_id, m) for m in match_notice_for_org(org_id, n))
    return out


def backfill_org(org_id: uuid.UUID, search_id: uuid.UUID | None = None, limit: int = 500) -> list[uuid.UUID]:
    """Match an organisation's active searches against notices that are already stored and still open.

    Run when a saved search is created or changed, so a new search shows today's opportunities immediately.
    When `search_id` is given, candidates are pre-filtered in SQL by that search's country, CPV and value
    criteria; keywords and buyer names are then checked in Python. Returns ids of matches needing qualification.
    """
    from datetime import UTC, datetime

    from sqlalchemy import exists, or_

    conds = [
        Notice.status == "open",
        Notice.notice_type.like("cn-%"),
        or_(Notice.deadline_at.is_(None), Notice.deadline_at > datetime.now(UTC)),
    ]
    if search_id is not None:
        with tenant_session(org_id) as tdb:
            search = tdb.get(SavedSearch, search_id)
            view = _search_view(search) if search is not None else None
        if view is None:
            return []
        if view.countries:
            conds.append(Notice.country.in_([c.upper() for c in view.countries]))
        if view.cpv_codes:
            conds.append(
                exists().where(
                    NoticeCpv.notice_id == Notice.id,
                    or_(*[NoticeCpv.cpv_code.like(f"{cpv_prefix(c)}%") for c in view.cpv_codes]),
                )
            )
        if view.min_value is not None:
            conds.append(or_(Notice.estimated_value.is_(None), Notice.estimated_value >= view.min_value))
        if view.max_value is not None:
            conds.append(or_(Notice.estimated_value.is_(None), Notice.estimated_value <= view.max_value))
    with public_session() as db:
        ids = list(
            db.scalars(
                select(Notice.id)
                .where(*conds)
                .order_by(Notice.publication_date.desc().nulls_last(), Notice.id)
                .limit(limit)
            )
        )
    out: list[uuid.UUID] = []
    for nid in ids:
        nview = load_notice_view(nid)
        if nview is not None:
            out.extend(match_notice_for_org(org_id, nview))
    return out
