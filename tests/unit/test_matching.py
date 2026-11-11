import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from tenderline.matching import NoticeView, SearchView, cpv_prefix, evaluate, is_open_call

NOW = datetime(2026, 11, 11, tzinfo=UTC)


def notice(**kw):
    base = dict(
        id=uuid.uuid4(),
        version=1,
        kind="call",
        status="open",
        title="Cloud hosting and cyber security services",
        summary="Managed hosting for a public body",
        buyer_name="Dublin City Council",
        country="IRL",
        cpv_codes=("72200000", "48000000"),
        value=Decimal("250000"),
        deadline_at=NOW + timedelta(days=30),
    )
    base.update(kw)
    return NoticeView(**base)


def search(**kw):
    base = dict(
        id=uuid.uuid4(), cpv_codes=(), buyer_names=(), keywords=(), countries=(), min_value=None, max_value=None
    )
    base.update(kw)
    return SearchView(**base)


def test_cpv_hierarchy_prefixes():
    assert cpv_prefix("72000000") == "72" and cpv_prefix("72200000") == "722" and cpv_prefix("45210000") == "4521"
    assert cpv_prefix("72212931") == "72212931"
    assert cpv_prefix("30000000") == "30" and cpv_prefix("10") == "10" and cpv_prefix("3") == "30"


def test_division_code_matches_any_child():
    assert evaluate(notice(), search(cpv_codes=("72000000",)))["cpv"] == ["72200000"]
    assert evaluate(notice(), search(cpv_codes=("48",)))["cpv"] == ["48000000"]
    assert evaluate(notice(), search(cpv_codes=("45000000",))) is None
    assert evaluate(notice(), search(cpv_codes=("72300000",))) is None  # sibling, not a parent


def test_criteria_are_anded_values_are_ored():
    assert evaluate(notice(), search(cpv_codes=("45", "72"), countries=("IRL",))) is not None
    assert evaluate(notice(), search(cpv_codes=("72",), countries=("GBR",))) is None
    assert evaluate(notice(), search(keywords=("nothing", "cyber"))) == {"keywords": ["cyber"]}


def test_keywords_match_word_starts_case_insensitively():
    assert evaluate(notice(), search(keywords=("HOSTING",))) is not None
    assert evaluate(notice(), search(keywords=("secur",))) is not None  # prefix of "security"
    assert evaluate(notice(), search(keywords=("sting",))) is None  # not the start of a word


def test_buyer_match_is_normalised():
    assert evaluate(notice(), search(buyer_names=("dublin city council ltd",))) is not None  # legal suffix ignored
    assert evaluate(notice(), search(buyer_names=("cork county council",))) is None
    assert evaluate(notice(), search(buyer_names=("DUBLIN CITY",))) is not None
    assert evaluate(notice(buyer_name=None), search(buyer_names=("dublin",))) is None


def test_value_range_and_unknown_value():
    assert evaluate(notice(), search(min_value=Decimal("100000"), max_value=Decimal("300000")))["value"] == "250000"
    assert evaluate(notice(), search(min_value=Decimal("300000"))) is None
    assert evaluate(notice(), search(max_value=Decimal("100000"))) is None
    r = evaluate(notice(value=None), search(min_value=Decimal("1")))
    assert r == {"value_unknown": True}


def test_empty_search_matches_everything_but_api_forbids_it():
    assert evaluate(notice(), search()) == {}


def test_open_call_eligibility():
    assert is_open_call(notice(), NOW)
    assert not is_open_call(notice(deadline_at=NOW - timedelta(days=1)), NOW)
    assert is_open_call(notice(deadline_at=None), NOW)
    assert not is_open_call(notice(status="awarded"), NOW)
    assert not is_open_call(notice(kind="award"), NOW)


def test_division_30_does_not_match_division_34():
    n = notice(cpv_codes=("34100000",))
    assert evaluate(n, search(cpv_codes=("30000000",))) is None
    assert evaluate(notice(cpv_codes=("30231300",)), search(cpv_codes=("30000000",))) is not None
