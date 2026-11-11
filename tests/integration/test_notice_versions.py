"""Regression tests for how publications are linked into notice versions."""

import copy
import uuid
from datetime import date

import httpx
import pytest
from sqlalchemy import text

from tenderline import notices
from tenderline.db import owner_session, public_session
from tenderline.ted.client import TedClient, TedError
from tenderline.ted.parse import changed_notice_identifier, parse_ted_notice
from tests.helpers import raw_notice, reset_notice_tables


@pytest.fixture(autouse=True)
def _clean(migrated_db):
    reset_notice_tables()


def store(raw):
    with public_session() as db:
        return notices.store_notice(db, parse_ted_notice(raw))


def change_notice_for(original, **changes):
    """A TED change notice: new publication number and identifier, pointing at the notice it corrects."""
    change = copy.deepcopy(original)
    change.update(
        {
            "publication-number": f"{uuid.uuid4().int % 10**6}-2026",
            "notice-identifier": str(uuid.uuid4()),
            "notice-version": 2,
            "change-notice-version-identifier": f"{original['notice-identifier']}-01",
            **changes,
        }
    )
    return change


def version_count(notice_id):
    with owner_session() as db:
        return db.execute(text("SELECT count(*) FROM notice_versions WHERE notice_id=:n"), {"n": notice_id}).scalar()


def test_identifier_suffix_is_stripped_from_the_change_reference():
    assert (
        changed_notice_identifier("47ac9b70-671f-4cc5-a97b-7ea62b383718-01") == "47ac9b70-671f-4cc5-a97b-7ea62b383718"
    )
    assert (
        changed_notice_identifier(["47ac9b70-671f-4cc5-a97b-7ea62b383718-12"]) == "47ac9b70-671f-4cc5-a97b-7ea62b383718"
    )
    assert changed_notice_identifier(None) is None and changed_notice_identifier([]) is None


def test_a_change_notice_becomes_a_new_version_not_a_second_notice():
    original = raw_notice(value="100000")
    first = store(original)
    change = change_notice_for(original, **{"estimated-value-lot": ["250000"]})
    second = store(change)
    assert second.notice_id == first.notice_id and second.action == "updated" and second.version == 2
    assert second.changes["estimated_value"] == {"old": "100000", "new": "250000"}
    with owner_session() as db:
        assert db.execute(text("SELECT count(*) FROM notices")).scalar() == 1


def test_a_chain_of_change_notices_stays_on_one_notice():
    original = raw_notice()
    first = store(original)
    change_1 = change_notice_for(original, **{"notice-title": {"eng": "First correction"}})
    change_2 = change_notice_for(change_1, **{"notice-title": {"eng": "Second correction"}})  # corrects the correction
    assert store(change_1).version == 2
    third = store(change_2)
    assert third.notice_id == first.notice_id and third.version == 3


def test_rereading_the_original_after_a_change_does_not_undo_the_change():
    original = raw_notice(value="100000")
    first = store(original)
    store(change_notice_for(original, **{"estimated-value-lot": ["250000"]}))
    again = store(original)  # the daily window re-reads older publications
    assert again.action == "unchanged" and version_count(first.notice_id) == 2
    with owner_session() as db:
        assert db.execute(text("SELECT estimated_value FROM notices")).scalar() == 250000


def test_an_original_arriving_after_its_change_notice_is_ignored_as_older():
    original = raw_notice()
    change = change_notice_for(original, **{"notice-title": {"eng": "Corrected"}})
    stored_change = store(change)  # the ingestion window started after the original was published
    late_original = store(original)
    assert late_original.notice_id == stored_change.notice_id and late_original.action == "unchanged"
    with owner_session() as db:
        assert db.execute(text("SELECT title FROM notices")).scalar() == "Corrected"


def test_a_change_back_to_earlier_wording_is_recorded():
    raw = raw_notice(value="100000")
    first = store(raw)
    store({**raw, "estimated-value-lot": ["250000"]})
    reverted = store(raw)  # same publication, back to the first content
    assert reverted.action == "updated" and reverted.version == 3
    assert version_count(first.notice_id) == 3


def test_one_unstorable_notice_does_not_block_the_page(monkeypatch):
    good_1, bad, good_2 = raw_notice(title="Good one"), raw_notice(title="Bad"), raw_notice(title="Good two")
    real_store = notices.store_notice

    def failing_store(db, parsed):
        if parsed.title == "Bad":
            db.execute(text("SELECT 1/0"))  # a database error in the middle of the page
        return real_store(db, parsed)

    monkeypatch.setattr(notices, "store_notice", failing_store)
    run_id = notices.start_run("ted", date(2026, 11, 1))
    events = notices.ingest_batch(run_id, [good_1, bad, good_2], "next", 1, "q")
    assert len(events) == 2
    with owner_session() as db:
        seen, new, skipped = db.execute(
            text("SELECT notices_seen, notices_new, notices_skipped FROM ingestion_runs WHERE id=:r"), {"r": run_id}
        ).one()
        titles = {row[0] for row in db.execute(text("SELECT title FROM notices"))}
    assert (seen, new, skipped) == (3, 2, 1) and titles == {"Good one", "Good two"}


def test_starting_a_run_closes_runs_that_died_without_a_cursor():
    dead = notices.start_run("ted", date(2026, 11, 1))
    fresh = notices.start_run("ted", date(2026, 11, 2))
    with owner_session() as db:
        status = dict(db.execute(text("SELECT id, status FROM ingestion_runs")).all())
    assert status[dead] == "abandoned" and status[fresh] == "running"


def test_a_timed_out_search_is_retried_not_treated_as_a_complete_page():
    answers = [
        httpx.Response(200, json={"notices": [], "timedOut": True}),
        httpx.Response(200, json={"notices": [{"publication-number": "1-2026"}], "timedOut": False}),
    ]
    client = TedClient(
        transport=httpx.MockTransport(lambda request: answers.pop(0)), sleep=lambda seconds: None, rand=lambda: 0.0
    )
    assert [n["publication-number"] for n in client.search_page("q").notices] == ["1-2026"]
    always_timing_out = TedClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"notices": [], "timedOut": True})),
        sleep=lambda seconds: None,
        rand=lambda: 0.0,
        max_attempts=2,
    )
    with pytest.raises(TedError, match="timed out"):
        always_timing_out.search_page("q")
