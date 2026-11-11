import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from tenderline.ted.parse import content_hash, notice_kind, parse_ted_notice
from tenderline.ted.query import build_ingest_query

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "ted"


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))["notices"]


def test_parse_call_notice_from_recorded_response():
    raw = next(n for n in load("cn_recent_page1.json") if n.get("estimated-value-lot"))
    p = parse_ted_notice(raw)
    assert p.source == "ted" and p.source_id == raw["publication-number"]
    assert p.kind == "call" and p.country == "IRL"
    assert p.source_url == f"https://ted.europa.eu/en/notice/{p.source_id}/html"
    assert p.title and len(p.title) <= 500
    assert p.buyer_name
    assert p.publication_date and isinstance(p.publication_date, date)
    assert p.estimated_value is not None and p.currency == "EUR"
    assert len(p.cpv_codes) == len(set(p.cpv_codes))  # duplicates removed, order kept


def test_summary_is_short_and_free_text_is_not_stored():
    for raw in load("cn_recent_page1.json") + load("cn_recent_page2.json"):
        p = parse_ted_notice(raw)
        assert p.summary is None or len(p.summary) <= 280
        snap = json.dumps(p.snapshot())
        assert "description-lot" not in snap


def test_parse_award_notice():
    raws = load("can_recent_page1.json")
    parsed = [parse_ted_notice(r) for r in raws]
    assert all(p.kind == "award" and p.award is not None for p in parsed)
    assert all(p.procedure_id for p in parsed)
    with_winner = [p for p in parsed if p.award["winners"]]
    without = [p for p in parsed if not p.award["winners"]]
    assert all(p.award["awarded"] for p in with_winner)
    assert all(not p.award["awarded"] for p in without)


def test_deadline_date_only_is_end_of_day_utc():
    p = parse_ted_notice(
        {
            "publication-number": "1-2026",
            "notice-type": "cn-standard",
            "notice-title": {"eng": "t"},
            "deadline-receipt-tender-date-lot": ["2026-12-16Z"],
        }
    )
    assert p.deadline_at == datetime(2026, 12, 16, 23, 59, 59, tzinfo=UTC) and p.deadline_precision == "date"


def test_deadline_datetime_and_earliest_lot_wins():
    p = parse_ted_notice(
        {
            "publication-number": "1-2026",
            "notice-type": "cn-standard",
            "notice-title": {"eng": "t"},
            "deadline-receipt-tender-date-lot": ["2026-12-16T12:00:00+01:00", "2026-12-01Z"],
        }
    )
    assert p.deadline_at == datetime(2026, 12, 1, 23, 59, 59, tzinfo=UTC)


def test_lot_values_are_summed_per_currency():
    p = parse_ted_notice(
        {
            "publication-number": "1-2026",
            "notice-type": "cn-standard",
            "notice-title": {"eng": "t"},
            "estimated-value-lot": ["100", "50.5", "7"],
            "estimated-value-cur-lot": ["EUR", "EUR", "GBP"],
        }
    )
    assert p.estimated_value == Decimal("150.5") and p.currency == "EUR" and len(p.lots) == 3


def test_title_falls_back_through_languages_and_missing_fields_are_tolerated():
    p = parse_ted_notice({"publication-number": "9-2026", "notice-title": {"gle": "Teideal"}})
    assert p.title == "Teideal" and p.notice_type == "unknown" and p.deadline_at is None
    with pytest.raises(ValueError):
        parse_ted_notice({"notice-type": "cn-standard"})


def test_content_hash_ignores_links_and_detects_changes():
    a = {"publication-number": "1", "x": 1, "links": {"a": 1}}
    assert content_hash(a) == content_hash({"publication-number": "1", "x": 1, "links": {"b": 2}})
    assert content_hash(a) != content_hash({"publication-number": "1", "x": 2})


def test_notice_kind():
    assert [notice_kind(t) for t in ("cn-standard", "can-social", "pin-only", "corr")] == [
        "call",
        "award",
        "other",
        "other",
    ]


def test_query_builder():
    assert (
        build_ingest_query("IRL", date(2026, 11, 1))
        == "buyer-country=IRL AND publication-date>=20261101 SORT BY publication-date"
    )
    q = build_ingest_query("IRL", date(2026, 11, 1), ["72", "48"])
    assert q.startswith("(buyer-country=IRL OR classification-cpv=72* OR classification-cpv=48*) AND ")
    for bad in ("7x", "", "123456789"):
        with pytest.raises(ValueError):
            build_ingest_query("IRL", date(2026, 1, 1), [bad])
    with pytest.raises(ValueError):
        build_ingest_query("IE", date(2026, 1, 1))


def test_deadlines_in_recorded_notices_are_timezone_aware():
    raws = [
        r
        for r in load("cn_recent_page1.json") + load("cn_recent_page2.json")
        if r.get("deadline-receipt-tender-date-lot")
    ]
    assert raws, "fixtures should include at least one notice with a deadline"
    for raw in raws:
        p = parse_ted_notice(raw)
        assert p.deadline_at is not None and p.deadline_at.tzinfo is not None
