import copy
import json
import uuid
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from tenderline import notices as N
from tenderline.api.app import create_app
from tenderline.db import owner_session, public_session
from tenderline.etenders import CsvFormatError, load_csv
from tenderline.security import create_token
from tenderline.ted.parse import parse_ted_notice

FIX = Path(__file__).resolve().parents[1] / "fixtures"


def ted(name):
    return json.loads((FIX / "ted" / name).read_text(encoding="utf-8"))["notices"]


@pytest.fixture()
def clean_notices(migrated_db):
    with owner_session() as s:
        s.execute(text("ALTER TABLE notice_versions DISABLE TRIGGER USER"))
        s.execute(
            text("TRUNCATE notices, notice_versions, lots, notice_cpv, buyers, cpv_codes, ingestion_runs CASCADE")
        )
        s.execute(text("ALTER TABLE notice_versions ENABLE TRIGGER USER"))


def unique(raw):
    """Make a recorded notice unique per test so tests do not collide."""
    r = copy.deepcopy(raw)
    r["publication-number"] = f"{uuid.uuid4().int % 10**6}-2026"
    r["notice-identifier"] = str(uuid.uuid4())
    r["procedure-identifier"] = str(uuid.uuid4())
    return r


def test_new_notice_is_stored_with_raw_payload_and_structured_fields(clean_notices):
    raw = ted("cn_recent_page1.json")[0]
    with public_session() as db:
        res = N.store_notice(db, parse_ted_notice(raw))
    assert res.action == "new" and res.version == 1
    with owner_session() as s:
        row = s.execute(text("SELECT raw, fields, content_hash FROM notice_versions")).one()
        assert row[0]["publication-number"] == raw["publication-number"]  # raw kept verbatim for replay
        assert row[1]["publication_number"] == raw["publication-number"]
        n = s.execute(text("SELECT source_url, summary, country FROM notices")).one()
        assert n[0].startswith("https://ted.europa.eu/en/notice/") and (n[1] is None or len(n[1]) <= 280)


def test_reingesting_the_same_page_changes_nothing(clean_notices):
    raws = ted("cn_recent_page1.json")
    with public_session() as db:
        first = [N.store_notice(db, parse_ted_notice(r)).action for r in raws]
    with public_session() as db:
        second = [N.store_notice(db, parse_ted_notice(r)).action for r in raws]
    assert first == ["new", "new"] and second == ["unchanged", "unchanged"]
    with owner_session() as s:
        assert s.execute(text("SELECT count(*) FROM notice_versions")).scalar() == 2


def test_corrigendum_creates_a_new_version_and_flags_changes(clean_notices):
    raw = unique(ted("cn_recent_page1.json")[0])
    raw["deadline-receipt-tender-date-lot"] = ["2026-12-16Z"]
    raw["estimated-value-lot"], raw["estimated-value-cur-lot"] = ["100000"], ["EUR"]
    with public_session() as db:
        v1 = N.store_notice(db, parse_ted_notice(raw))
    changed = copy.deepcopy(raw)
    changed["deadline-receipt-tender-date-lot"] = ["2027-01-20Z"]
    changed["estimated-value-lot"] = ["250000"]
    with public_session() as db:
        v2 = N.store_notice(db, parse_ted_notice(changed))
    assert v2.notice_id == v1.notice_id and v2.action == "updated" and v2.version == 2
    assert set(v2.changes) == {"deadline_at", "estimated_value"}
    assert v2.changes["estimated_value"] == {"old": "100000", "new": "250000"}
    with owner_session() as s:
        versions = s.execute(
            text("SELECT version FROM notice_versions WHERE notice_id=:n ORDER BY 1"), {"n": v1.notice_id}
        ).all()
        assert [v[0] for v in versions] == [1, 2]  # history preserved, never overwritten
        assert s.execute(
            text("SELECT current_version, estimated_value FROM notices WHERE id=:n"), {"n": v1.notice_id}
        ).one() == (2, 250000)
        old = s.execute(
            text("SELECT raw FROM notice_versions WHERE notice_id=:n AND version=1"), {"n": v1.notice_id}
        ).scalar()
        assert old["estimated-value-lot"] == ["100000"]


def test_new_publication_number_with_same_notice_identifier_is_a_new_version(clean_notices):
    raw = unique(ted("cn_recent_page1.json")[0])
    with public_session() as db:
        first = N.store_notice(db, parse_ted_notice(raw))
    corr = copy.deepcopy(raw)
    corr["publication-number"], corr["notice-title"] = "999999-2026", {"eng": "Corrected title"}
    with public_session() as db:
        res = N.store_notice(db, parse_ted_notice(corr))
        again = N.store_notice(db, parse_ted_notice(corr))
    assert res.notice_id == first.notice_id and res.action == "updated" and "title" in res.changes
    assert again.action == "unchanged"


def test_award_notice_closes_the_related_call(clean_notices):
    call = unique(ted("cn_recent_page1.json")[0])
    award = copy.deepcopy(ted("can_recent_page1.json")[0])
    award["publication-number"], award["notice-identifier"] = "888888-2026", str(uuid.uuid4())
    award["procedure-identifier"] = call["procedure-identifier"]
    with public_session() as db:
        c = N.store_notice(db, parse_ted_notice(call))
        a = N.store_notice(db, parse_ted_notice(award))
    assert a.awarded_notice_ids == [c.notice_id]
    with owner_session() as s:
        status, award_json = s.execute(text("SELECT status, award FROM notices WHERE id=:i"), {"i": c.notice_id}).one()
    assert status == "awarded" and "selection_status" in award_json


def test_buyer_names_are_normalised_and_deduplicated(clean_notices):
    assert N.normalise_name("Dublin City Council Ltd.") == N.normalise_name("DUBLIN  CITY COUNCIL")
    r1, r2 = unique(ted("cn_recent_page1.json")[0]), unique(ted("cn_recent_page1.json")[0])
    r1["buyer-name"] = {"eng": ["Office of Public Works"]}
    r2["buyer-name"] = {"eng": ["OFFICE OF PUBLIC WORKS"]}
    with public_session() as db:
        N.store_notice(db, parse_ted_notice(r1))
        N.store_notice(db, parse_ted_notice(r2))
    with owner_session() as s:
        assert (
            s.execute(text("SELECT count(*) FROM buyers WHERE normalised_name='office of public works'")).scalar() == 1
        )


def test_ingest_batch_moves_cursor_atomically_and_reports_events(clean_notices):
    run_id = N.start_run("ted", date(2026, 11, 1))
    raws = ted("cn_recent_page1.json")
    events = N.ingest_batch(run_id, raws, "tok-2", 1, "q")
    assert [e["action"] for e in events] == ["new", "new"]
    assert N.ingest_batch(run_id, raws, "tok-2", 1, "q") == []  # replaying a page is harmless
    resume = N.last_cursor("ted")
    assert resume and resume["cursor"] == {"token": "tok-2", "page": 1, "query": "q"}
    with owner_session() as s:
        seen, new = s.execute(text("SELECT notices_seen, notices_new FROM ingestion_runs")).one()
    assert (seen, new) == (4, 2)
    N.finish_run(run_id, "ok")
    assert N.last_cursor("ted") is None and N.last_success_date("ted") is not None


def test_unparseable_notices_are_skipped_not_fatal(clean_notices):
    run_id = N.start_run("ted", date(2026, 11, 1))
    good = ted("cn_recent_page1.json")[0]
    events = N.ingest_batch(run_id, [{"no": "publication-number"}, good], None, 1, "q")
    assert len(events) == 1


# ---------------------------------------------------------------- eTenders CSV loader
def test_etenders_loader_detects_columns_and_encoding(clean_notices):
    stats = load_csv(FIX / "etenders_sample.csv")
    assert stats.encoding == "cp1252" and stats.rows == 4 and stats.new == 4
    assert stats.columns["value"].startswith("Sum of Notice Estimated Value")
    with owner_session() as s:
        rows = {
            r[0]: r
            for r in s.execute(
                text(
                    "SELECT source_id, title, status, estimated_value, deadline_at FROM notices WHERE source='etenders'"
                )
            )
        }
        assert rows["9157739"][1].startswith("Design and Build") and rows["9157739"][3] == 34000000
        assert rows["9169069"][2] == "awarded" and rows["9200001"][2] == "cancelled" and rows["8974552"][2] == "open"
        buyer = s.execute(text("SELECT name FROM buyers WHERE name LIKE 'Iarn%'")).scalar()
        assert buyer == "Iarnród Éireann-Irish Rail"  # cp1252 decoded correctly
        cpvs = s.execute(
            text("SELECT count(*) FROM notice_cpv nc JOIN notices n ON n.id=nc.notice_id WHERE n.source_id='8974552'")
        ).scalar()
        assert cpvs == 3


def test_etenders_loader_is_idempotent(clean_notices):
    load_csv(FIX / "etenders_sample.csv")
    again = load_csv(FIX / "etenders_sample.csv")
    assert again.unchanged == 4 and again.new == 0 and again.updated == 0


def test_etenders_loader_rejects_wrong_files_clearly(clean_notices):
    with pytest.raises(CsvFormatError, match="required column"):
        load_csv(FIX / "etenders_bad_header.csv")


def test_etenders_since_filter(clean_notices):
    stats = load_csv(FIX / "etenders_sample.csv", since=date(2026, 10, 1))
    assert stats.new == 1 and stats.skipped == 3  # only the 01/10/2026 row is on/after the cutoff


# ---------------------------------------------------------------- notices API
@pytest.fixture()
def api(clean_notices, make_org):
    with TestClient(create_app()) as c:
        user = make_org()["user_id"]
        yield c, {"Authorization": f"Bearer {create_token(user)}"}


def test_notices_api_filters_pagination_and_no_raw_text(api):
    client, h = api
    load_csv(FIX / "etenders_sample.csv")
    r = client.get("/v1/notices?limit=2", headers=h).json()
    assert len(r["items"]) == 2 and r["next_cursor"]
    seen = {i["id"] for i in r["items"]}
    r2 = client.get(f"/v1/notices?limit=2&cursor={r['next_cursor']}", headers=h).json()
    assert len(r2["items"]) == 2 and not (seen & {i["id"] for i in r2["items"]}) and r2["next_cursor"] is None
    assert all("raw" not in i for i in r["items"] + r2["items"])
    only = client.get("/v1/notices?cpv=45&status=open", headers=h).json()["items"]
    assert {i["source_id"] for i in only} == {"8974552", "9157739"}
    assert client.get("/v1/notices?q=maintenance", headers=h).json()["items"][0]["source_id"] == "9169069"
    assert [
        i["source_id"] for i in client.get("/v1/notices?buyer=dublin city&min_value=1000000", headers=h).json()["items"]
    ] == ["8974552"]
    bad = client.get("/v1/notices?cursor=not-a-cursor", headers=h)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_cursor"
    assert client.get("/v1/notices").status_code == 401


def test_notice_detail_and_version_history(api):
    client, h = api
    raw = unique(ted("cn_recent_page1.json")[0])
    with public_session() as db:
        res = N.store_notice(db, parse_ted_notice(raw))
        changed = copy.deepcopy(raw)
        changed["notice-title"] = {"eng": "Amended title"}
        N.store_notice(db, parse_ted_notice(changed))
    d = client.get(f"/v1/notices/{res.notice_id}", headers=h).json()
    assert d["current_version"] == 2 and d["title"] == "Amended title" and d["buyer_name"]
    v = client.get(f"/v1/notices/{res.notice_id}/versions", headers=h).json()
    assert [x["version"] for x in v] == [1, 2] and v[1]["changes"]["title"]["new"] == "Amended title"
    assert "raw" not in v[0]
    assert client.get(f"/v1/notices/{uuid.uuid4()}", headers=h).status_code == 404


def test_etenders_load_queues_matching_only_for_open_notices(clean_notices):
    from tenderline.etenders import open_event_ids

    stats = load_csv(FIX / "etenders_sample.csv")
    open_events = open_event_ids(stats.events)
    with owner_session() as s:
        open_ids = {
            str(r[0])
            for r in s.execute(
                text(
                    "SELECT id FROM notices WHERE source='etenders' AND status='open' AND (deadline_at IS NULL OR deadline_at > now())"
                )
            )
        }
    assert {e["notice_id"] for e in open_events} == open_ids  # awarded/cancelled/past-deadline rows are excluded
    assert len(open_events) < len(stats.events)
