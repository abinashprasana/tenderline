"""Normalise raw TED search results into structured, source-agnostic notice data.

Field shapes were verified against live responses (recorded in tests/fixtures/ted):
  buyer-name  {"eng": ["Name"]}            notice-title  {"eng": "Title", ...}
  deadline-receipt-tender-date-lot ["2026-12-16Z"]   estimated-value-lot ["100000"] + estimated-value-cur-lot ["EUR"]
  classification-cpv ["80500000", ...] (contains duplicates)   publication-date "2026-11-11+01:00"
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time
from decimal import Decimal, InvalidOperation
from typing import Any

SUMMARY_MAX = 280
TITLE_MAX = 500
_LANG_PREF = ("eng", "gle")

_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


@dataclass
class ParsedNotice:
    source: str
    source_id: str
    notice_type: str
    title: str
    source_url: str
    notice_identifier: str | None = None
    changed_notice_identifier: str | None = None  # set on change notices: the notice this one corrects
    procedure_id: str | None = None
    source_version: int | None = None
    summary: str | None = None
    buyer_name: str | None = None
    country: str | None = None
    publication_date: date | None = None
    deadline_at: datetime | None = None
    deadline_precision: str | None = None
    estimated_value: Decimal | None = None
    currency: str | None = None
    cpv_codes: list[str] = field(default_factory=list)
    lots: list[dict[str, Any]] = field(default_factory=list)
    award: dict[str, Any] | None = None
    status: str | None = None  # explicit status override (e.g. eTenders cancelled rows)
    content_hash: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def kind(self) -> str:
        return notice_kind(self.notice_type)

    def snapshot(self) -> dict[str, Any]:
        """Structured fields stored per version. Intentionally has no long buyer free text."""
        return {
            "publication_number": self.source_id,
            "notice_identifier": self.notice_identifier,
            "changed_notice_identifier": self.changed_notice_identifier,
            "procedure_id": self.procedure_id,
            "source_version": self.source_version,
            "notice_type": self.notice_type,
            "title": self.title,
            "summary": self.summary,
            "buyer_name": self.buyer_name,
            "country": self.country,
            "publication_date": self.publication_date.isoformat() if self.publication_date else None,
            "deadline_at": self.deadline_at.isoformat() if self.deadline_at else None,
            "deadline_precision": self.deadline_precision,
            "estimated_value": str(self.estimated_value) if self.estimated_value is not None else None,
            "currency": self.currency,
            "cpv_codes": self.cpv_codes,
            "lots": self.lots,
            "award": self.award,
        }


_VERSION_SUFFIX = re.compile(r"-\d{1,3}$")


def changed_notice_identifier(value: Any) -> str | None:
    """A change notice names the notice it corrects as "<notice-identifier>-<version>", e.g.
    "47ac9b70-671f-4cc5-a97b-7ea62b383718-01" (checked against live TED data). Return the identifier part."""
    if isinstance(value, list):
        value = value[0] if value else None
    if not isinstance(value, str) or not value:
        return None
    return _VERSION_SUFFIX.sub("", value)


def notice_kind(notice_type: str) -> str:
    if notice_type.startswith("can-"):
        return "award"
    if notice_type.startswith("cn-"):
        return "call"
    return "other"


def _pick_lang(value: Any) -> str | None:
    """Pick one string from a {lang: str | [str]} mapping, preferring English."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return str(value[0]) if value else None
    if isinstance(value, dict):
        for lang in (*_LANG_PREF, *value.keys()):
            v = value.get(lang)
            if v:
                return str(v[0]) if isinstance(v, list) else str(v)
    return None


def _first(value: Any) -> Any:
    return value[0] if isinstance(value, list) and value else value if not isinstance(value, list) else None


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    m = _DATE_RE.match(value)
    return date.fromisoformat(m.group(1)) if m else None


def _parse_deadline(value: str) -> tuple[datetime, str]:
    """TED gives either a date ("2026-12-16Z") or a date-time. Date-only deadlines are stored as the end of
    that day (UTC) with precision "date", so a reminder never fires too late."""
    if "T" in value:
        text = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).astimezone(UTC), "datetime"
    d = _parse_date(value)
    if d is None:
        raise ValueError(f"unparseable deadline {value!r}")
    return datetime.combine(d, time(23, 59, 59), tzinfo=UTC), "date"


def _decimal(value: Any) -> Decimal | None:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def content_hash(raw: dict[str, Any]) -> str:
    stable = {k: v for k, v in raw.items() if k != "links"}
    return hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def parse_ted_notice(raw: dict[str, Any]) -> ParsedNotice:
    pub = raw.get("publication-number")
    if not pub:
        raise ValueError("TED notice has no publication-number")
    notice_type = str(raw.get("notice-type") or "unknown")
    title = (_pick_lang(raw.get("notice-title")) or f"TED notice {pub}")[:TITLE_MAX]

    descriptions = raw.get("description-lot")
    desc = _pick_lang(descriptions)
    summary = (desc[: SUMMARY_MAX - 1].rstrip() + "…") if desc and len(desc) > SUMMARY_MAX else desc

    values = raw.get("estimated-value-lot") or []
    currencies = raw.get("estimated-value-cur-lot") or []
    deadlines = raw.get("deadline-receipt-tender-date-lot") or []
    n_lots = max(len(values), len(deadlines))
    lots: list[dict[str, Any]] = []
    for i in range(n_lots):
        v = _decimal(values[i]) if i < len(values) else None
        dl = None
        if i < len(deadlines):
            try:
                dl = _parse_deadline(deadlines[i])[0].isoformat()
            except ValueError:
                dl = None
        lots.append(
            {
                "position": i + 1,
                "estimated_value": str(v) if v is not None else None,
                "currency": currencies[i] if i < len(currencies) else None,
                "deadline_at": dl,
            }
        )

    total: Decimal | None = None
    currency = currencies[0] if currencies else None
    for i, v in enumerate(values):
        d = _decimal(v)
        if d is not None and (i >= len(currencies) or currencies[i] == currency):
            total = (total or Decimal(0)) + d
    deadline_at, precision = None, None
    parsed_deadlines = []
    for dl in deadlines:
        try:
            parsed_deadlines.append(_parse_deadline(dl))
        except ValueError:
            continue
    if parsed_deadlines:
        deadline_at, precision = min(parsed_deadlines, key=lambda t: t[0])  # earliest lot deadline

    cpv_codes = list(dict.fromkeys(str(c) for c in raw.get("classification-cpv") or []))

    award: dict[str, Any] | None = None
    if notice_kind(notice_type) == "award":
        winners_raw = raw.get("winner-name")
        winners: list[str] = []
        if isinstance(winners_raw, dict):
            for lang in (*_LANG_PREF, *winners_raw.keys()):
                if winners_raw.get(lang):
                    winners = [str(w) for w in winners_raw[lang]]
                    break
        tv = raw.get("total-value")
        status = raw.get("winner-selection-status") or []
        award = {
            "winners": winners,
            "total_value": str(tv) if tv is not None else None,
            "currency": currency,
            "selection_status": status,
            "awarded": bool(winners),
        }

    return ParsedNotice(
        source="ted",
        source_id=str(pub),
        notice_type=notice_type,
        title=title,
        source_url=f"https://ted.europa.eu/en/notice/{pub}/html",
        notice_identifier=raw.get("notice-identifier"),
        changed_notice_identifier=changed_notice_identifier(raw.get("change-notice-version-identifier")),
        procedure_id=raw.get("procedure-identifier"),
        source_version=raw.get("notice-version"),
        summary=summary,
        buyer_name=_pick_lang(raw.get("buyer-name")),
        country=_first(raw.get("buyer-country")),
        publication_date=_parse_date(raw.get("publication-date")),
        deadline_at=deadline_at,
        deadline_precision=precision,
        estimated_value=total,
        currency=currency,
        cpv_codes=cpv_codes,
        lots=lots,
        award=award,
        content_hash=content_hash(raw),
        raw=raw,
    )
