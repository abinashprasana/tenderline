"""Loader for the eTenders open-data CSV ("Contract Notices Published on eTenders", CC BY 4.0, published by
the Office of Government Procurement on data.gov.ie).

The loader imports a local file path (it never downloads anything). Columns are detected from the header row
rather than assumed, because the publisher renames and reorders columns between releases. The header the
loader was written against (checked 2026-11-11) includes: "Tender ID", "Contracting Authority",
"Tender/Contract Name", "Notice Published Date / Contract Created Date", "Main Cpv Code",
"Additional CPV Codes on CFT", "Tender Submission Deadline", "Sum of Notice Estimated Value (EUR)",
"Cancelled Date", "Award Published", "Sum of Awarded Value (EUR)", "Awarded Suppliers", "TED Notice Link".
"""

from __future__ import annotations

import csv
import logging
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from tenderline.db import public_session
from tenderline.notices import store_notice
from tenderline.ted.parse import SUMMARY_MAX, TITLE_MAX, ParsedNotice, content_hash

log = logging.getLogger(__name__)

DATASET_URL = "https://data.gov.ie/dataset/contract-notices-published-on-etenders"
BATCH = 500


class CsvFormatError(ValueError):
    """The file does not look like the eTenders dataset (a required column is missing)."""


def _key(header: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", header.lower())


# logical field -> predicate on the normalised header. Matching on normalised prefixes tolerates the mangled
# currency symbol and small wording changes.
_COLUMNS: dict[str, Callable[[str], bool]] = {
    "id": lambda k: k == "tenderid",
    "buyer": lambda k: k == "contractingauthority",
    "title": lambda k: k.startswith("tendercontractname") or k == "tendername",
    "published": lambda k: k.startswith("noticepublisheddate"),
    "main_cpv": lambda k: k == "maincpvcode",
    "extra_cpv": lambda k: k.startswith("additionalcpvcodes"),
    "deadline": lambda k: k == "tendersubmissiondeadline",
    "value": lambda k: k.startswith("sumofnoticeestimatedvalue"),
    "cancelled": lambda k: k == "cancelleddate",
    "award_published": lambda k: k == "awardpublished",
    "award_value": lambda k: k.startswith("sumofawardedvalue"),
    "suppliers": lambda k: k == "awardedsuppliers",
    "ted_link": lambda k: k == "tednoticelink",
    "procedure": lambda k: k == "procedure",
    "contract_type": lambda k: k == "contracttype",
}
_REQUIRED = ("id", "buyer", "title", "published")


def detect_columns(header: list[str]) -> dict[str, str]:
    found: dict[str, str] = {}
    for name in header:
        k = _key(name)
        for logical, pred in _COLUMNS.items():
            if logical not in found and pred(k):
                found[logical] = name
    missing = [c for c in _REQUIRED if c not in found]
    if missing:
        raise CsvFormatError(f"required column(s) {missing} not found; header was: {header}")
    return found


def open_text(path: Path) -> tuple[Any, str]:
    """The published file is Windows-1252, not UTF-8. Try UTF-8 first (future-proof), then cp1252."""
    for enc in ("utf-8-sig", "cp1252"):
        try:
            with path.open(encoding=enc, newline="") as fh:
                while fh.read(1 << 20):
                    pass
            return path.open(encoding=enc, newline=""), enc
        except UnicodeDecodeError:
            continue
    raise CsvFormatError("file is neither UTF-8 nor Windows-1252 text")


def _date(value: str | None) -> date | None:
    if not value or not value.strip():
        return None
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d/%m/%Y %H:%M"):
        try:
            return datetime.strptime(value.strip(), fmt).date()  # noqa: DTZ007
        except ValueError:
            continue
    return None


def _money(value: str | None) -> Decimal | None:
    if not value or not value.strip():
        return None
    cleaned = re.sub(r"[^\d.\-]", "", value.replace(",", ""))
    try:
        return Decimal(cleaned) if cleaned else None
    except InvalidOperation:
        return None


def row_to_notice(row: dict[str, str], cols: dict[str, str]) -> ParsedNotice | None:
    def get(logical: str) -> str:
        return (row.get(cols[logical], "") if logical in cols else "").strip()

    tender_id = get("id")
    title = get("title")
    if not tender_id or not title:
        return None
    main = get("main_cpv")
    cpvs = list(
        dict.fromkeys(c for c in [main, *re.split(r"[;|,]\s*", get("extra_cpv"))] if re.fullmatch(r"\d{8}", c or ""))
    )
    deadline_d = _date(get("deadline"))
    awarded_on = _date(get("award_published"))
    cancelled_on = _date(get("cancelled"))
    suppliers = [s.strip() for s in re.split(r"[|;]", get("suppliers")) if s.strip()]
    award = None
    if awarded_on or suppliers:
        award = {
            "winners": suppliers,
            "total_value": str(_money(get("award_value"))) if _money(get("award_value")) is not None else None,
            "currency": "EUR",
            "awarded_on": awarded_on.isoformat() if awarded_on else None,
            "awarded": bool(suppliers),
        }
    link = get("ted_link")
    summary = f"{get('contract_type') or 'Contract'} - {get('procedure') or 'procedure not stated'}"
    raw = {k: v for k, v in row.items() if k}
    return ParsedNotice(
        source="etenders",
        source_id=tender_id,
        notice_type="cn-etenders",
        title=title[:TITLE_MAX],
        source_url=link or DATASET_URL,
        summary=summary[:SUMMARY_MAX],
        buyer_name=get("buyer") or None,
        country="IRL",
        publication_date=_date(get("published")),
        deadline_at=datetime.combine(deadline_d, time(23, 59, 59), tzinfo=UTC) if deadline_d else None,
        deadline_precision="date" if deadline_d else None,
        estimated_value=_money(get("value")),
        currency="EUR",
        cpv_codes=cpvs,
        award=award,
        status="cancelled" if cancelled_on else None,
        content_hash=content_hash(raw),
        raw=raw,
    )


@dataclass
class LoadStats:
    rows: int = 0
    new: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: int = 0
    encoding: str = ""
    columns: dict[str, str] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)


def iter_rows(path: Path) -> Iterator[tuple[dict[str, str], dict[str, str], str]]:
    fh, enc = open_text(path)
    with fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            raise CsvFormatError("empty file")
        cols = detect_columns(list(reader.fieldnames))
        for row in reader:
            yield row, cols, enc


def load_csv(
    path: Path, *, since: date | None = None, limit: int | None = None, only_open_after: datetime | None = None
) -> LoadStats:
    """Import the CSV. Idempotent: re-loading the same file changes nothing (content hashes)."""
    stats = LoadStats()
    batch: list[ParsedNotice] = []

    def flush() -> None:
        if not batch:
            return
        with public_session() as db:
            for p in batch:
                res = store_notice(db, p)
                setattr(stats, res.action, getattr(stats, res.action) + 1)
                if res.action != "unchanged":
                    stats.events.append(res.event())
        batch.clear()

    for row, cols, enc in iter_rows(path):
        stats.encoding, stats.columns = enc, cols
        stats.rows += 1
        parsed = row_to_notice(row, cols)
        if parsed is None or (since and parsed.publication_date and parsed.publication_date < since):
            stats.skipped += 1
            continue
        if only_open_after and (parsed.deadline_at is None or parsed.deadline_at < only_open_after):
            stats.skipped += 1
            continue
        batch.append(parsed)
        if len(batch) >= BATCH:
            flush()
        if limit and stats.rows >= limit:
            break
    flush()
    return stats
