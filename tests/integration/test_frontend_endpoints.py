"""Endpoints added for the web app: organisation list, overview summary, CPV search, token refresh, notice
sorting, and the opportunity list fields."""

from __future__ import annotations

import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from tenderline import cpv
from tenderline.api.app import create_app
from tenderline.config import get_settings
from tenderline.db import owner_session, tenant_session
from tenderline.opportunities import TRANSITIONS, ensure_opportunity
from tenderline.security import ISSUER, create_token
from tests.helpers import add_member, quiesce_workflows, raw_notice, reset_notice_tables, store

CPV_SAMPLE = Path(__file__).resolve().parents[1] / "fixtures" / "cpv" / "cpv_2008_sample.xml"
REPO = Path(__file__).resolve().parents[2]


def headers(user_id, key=None):
    h = {"Authorization": f"Bearer {create_token(user_id)}"}
    if key:
        h["Idempotency-Key"] = key
    return h


@pytest.fixture()
def client(migrated_db):
    reset_notice_tables()
    with TestClient(create_app()) as c:
        yield c
    quiesce_workflows()  # opportunity workflows started here must not outlive the test and block a TRUNCATE


def track(org_id, notice_id) -> dict:
    """Create the opportunity directly: the API route also starts its DBOS workflow, which these tests don't need."""
    with tenant_session(org_id) as db:
        opp, _ = ensure_opportunity(db, org_id, notice_id, actor_type="human", actor_id="test")
        return {"id": str(opp.id), "allowed_transitions": sorted(TRANSITIONS[opp.status])}


def add_proposal(org_id, notice_id, action="create_opportunity", fit=72, status="pending"):
    with owner_session() as s:
        s.execute(
            text(
                "INSERT INTO agent_proposals (organisation_id, notice_id, notice_version, action_type, payload, "
                "fit_score, status) VALUES (:o, :n, 1, :a, '{}', :f, :s)"
            ),
            {"o": org_id, "n": notice_id, "a": action, "f": fit, "s": status},
        )


# ------------------------------------------------------------------ CPV labels
def test_official_xml_reader_takes_english_label_and_strips_check_digit():
    rows = list(cpv.read_official_xml(CPV_SAMPLE))
    assert rows == [
        ("72000000", "IT services: consulting, software development, Internet and support"),
        ("72200000", "Software programming and consultancy services"),
        ("03000000", "Agricultural, farming, fishing, forestry and related products"),
    ]


def test_bundled_csv_is_the_full_official_list():
    rows = list(cpv.read_csv(cpv.BUNDLED_CSV))
    assert len(rows) == 9454
    assert all(len(code) == 8 and code.isdigit() for code, _ in rows)
    assert dict(rows)["72200000"] == "Software programming and consultancy services"


def test_cpv_search_by_prefix_words_and_division(client, make_org):
    user = make_org()["user_id"]
    cpv.store_labels(list(cpv.read_official_xml(CPV_SAMPLE)))
    # A code seen on a TED notice but never labelled is not offered in the picker.
    with owner_session() as s:
        s.execute(text("INSERT INTO cpv_codes (code, division) VALUES ('72210000', '72')"))

    def search(**params):
        r = client.get("/v1/cpv-codes", params=params, headers=headers(user))
        assert r.status_code == 200, r.text
        return [row["code"] for row in r.json()]

    assert search(q="72") == ["72000000", "72200000"]
    assert search(q="software programming") == ["72200000"]
    assert search(q="SOFTWARE") == ["72000000", "72200000"]
    assert search(divisions_only=True) == ["03000000", "72000000"]
    assert client.get("/v1/cpv-codes").status_code == 401


def test_store_labels_relabels_existing_codes(migrated_db):
    reset_notice_tables()
    with owner_session() as s:
        s.execute(text("INSERT INTO cpv_codes (code, division) VALUES ('72200000', '72')"))
    assert cpv.store_labels([("72200000", "Software programming and consultancy services")]) == 1
    with owner_session() as s:
        label = s.execute(text("SELECT description FROM cpv_codes WHERE code = '72200000'")).scalar_one()
    assert label == "Software programming and consultancy services"


# ------------------------------------------------------------------ organisations
def test_list_my_organisations_with_names_and_roles(client, make_org):
    first = make_org("Zeta Bids")
    second = make_org("Alpha Tenders")
    make_org("Not Mine")
    with owner_session() as s:
        s.execute(
            text("INSERT INTO memberships (organisation_id, user_id, role) VALUES (:o, :u, 'reviewer')"),
            {"o": second["org_id"], "u": first["user_id"]},
        )
    r = client.get("/v1/organisations", headers=headers(first["user_id"]))
    assert r.status_code == 200
    assert [(o["name"], o["role"]) for o in r.json()] == [("Alpha Tenders", "reviewer"), ("Zeta Bids", "owner")]


# ------------------------------------------------------------------ summary
def test_summary_counts(client, make_org):
    org = make_org()
    org_id, user = org["org_id"], org["user_id"]
    empty = client.get(f"/v1/organisations/{org_id}/summary", headers=headers(user)).json()
    assert empty["proposals_pending"] == 0
    assert empty["opportunities_by_status"] == dict.fromkeys(("new", "bid", "no_bid", "submitted", "won", "lost"), 0)
    assert [b["notices"] for b in empty["fit_score_histogram"]] == [0] * 10
    assert empty["last_ingestion"] is None

    hot = store(raw_notice(title="Cloud hosting")).notice_id
    cool = store(raw_notice(title="Catering")).notice_id
    add_proposal(org_id, hot, "create_opportunity", fit=91)
    add_proposal(org_id, hot, "add_deadline_reminders", fit=91)
    add_proposal(org_id, cool, "mark_no_bid", fit=15)
    add_proposal(org_id, cool, "create_opportunity", fit=15, status="rejected")

    created = track(org_id, hot)
    soon = (datetime.now(UTC) + timedelta(days=3)).isoformat()
    client.post(
        f"/v1/organisations/{org_id}/opportunities/{created['id']}/deadlines",
        json={"due_at": soon},
        headers=headers(user, "k-sum-002"),
    )

    body = client.get(f"/v1/organisations/{org_id}/summary", headers=headers(user)).json()
    assert body["proposals_pending"] == 3
    assert body["notices_awaiting_decision"] == 2
    assert body["opportunities_by_status"]["new"] == 1
    assert body["opportunities_open"] == 1
    assert body["deadlines_next_7_days"] == 1
    assert body["deadlines_next_30_days"] >= body["deadlines_next_7_days"]
    histogram = {b["lower"]: b["notices"] for b in body["fit_score_histogram"]}
    assert histogram[90] == 1 and histogram[10] == 1 and sum(histogram.values()) == 2
    assert body["notices_ingested_24h"] == 2

    # Another organisation sees none of it.
    other = make_org()
    theirs = client.get(f"/v1/organisations/{other['org_id']}/summary", headers=headers(other["user_id"])).json()
    assert theirs["proposals_pending"] == 0 and theirs["opportunities_open"] == 0
    # Non-members get 404, so organisation ids cannot be probed.
    assert client.get(f"/v1/organisations/{org_id}/summary", headers=headers(other["user_id"])).status_code == 404


# ------------------------------------------------------------------ opportunities
def test_opportunity_list_fills_counts_next_deadline_and_transitions(client, make_org):
    org = make_org()
    org_id, user = org["org_id"], org["user_id"]
    notice_id = store(raw_notice()).notice_id
    add_proposal(org_id, notice_id, "mark_no_bid")
    opp = track(org_id, notice_id)
    soon = datetime.now(UTC) + timedelta(days=2)
    client.post(
        f"/v1/organisations/{org_id}/opportunities/{opp['id']}/deadlines",
        json={"due_at": soon.isoformat(), "note": "internal review"},
        headers=headers(user, "k-opp-0002"),
    )

    listed = client.get(f"/v1/organisations/{org_id}/opportunities", headers=headers(user)).json()["items"]
    assert len(listed) == 1
    item = listed[0]
    assert item["pending_proposals"] == 1
    assert item["next_deadline"]["note"] == "internal review"
    assert item["deadlines"] == []
    assert item["allowed_transitions"] == ["bid", "no_bid"]

    detail = client.get(f"/v1/organisations/{org_id}/opportunities/{opp['id']}", headers=headers(user)).json()
    assert detail["next_deadline"]["note"] == "internal review"
    assert len(detail["deadlines"]) >= 1

    moved = client.patch(
        f"/v1/organisations/{org_id}/opportunities/{opp['id']}/status", json={"status": "bid"}, headers=headers(user)
    ).json()
    assert moved["allowed_transitions"] == ["no_bid", "submitted"]


# ------------------------------------------------------------------ token refresh
def test_refresh_issues_a_new_token_and_keeps_the_sign_in_time(client, make_org):
    user = make_org()["user_id"]
    signed_in = int(time.time()) - 3600
    old = create_token(user, signed_in_at=signed_in)
    r = client.post("/v1/auth/refresh", headers={"Authorization": f"Bearer {old}"})
    assert r.status_code == 200, r.text
    claims = jwt.decode(r.json()["access_token"], get_settings().jwt_secret, algorithms=["HS256"], issuer=ISSUER)
    assert claims["sub"] == str(user) and claims["auth_time"] == signed_in
    assert client.get("/v1/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"}).status_code == 200


def test_refresh_refuses_old_sessions_and_bad_tokens(client, make_org):
    user = make_org()["user_id"]
    stale = create_token(user, signed_in_at=int(time.time()) - 13 * 3600)
    r = client.post("/v1/auth/refresh", headers={"Authorization": f"Bearer {stale}"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "session_expired"
    assert client.post("/v1/auth/refresh").status_code == 401
    expired = jwt.encode(
        {"sub": str(user), "iss": ISSUER, "exp": int(time.time()) - 5}, get_settings().jwt_secret, algorithm="HS256"
    )
    r = client.post("/v1/auth/refresh", headers={"Authorization": f"Bearer {expired}"})
    assert r.json()["error"]["code"] == "invalid_token"
    unknown = create_token(uuid.uuid4())
    assert client.post("/v1/auth/refresh", headers={"Authorization": f"Bearer {unknown}"}).status_code == 401


# ------------------------------------------------------------------ notice sorting
def test_notices_sort_by_deadline_soonest_first_with_missing_last_across_pages(client, make_org):
    user = make_org()["user_id"]
    base = datetime.now(UTC)
    titles = {}
    for days in (40, 10, 25):
        titles[days] = store(
            raw_notice(title=f"due in {days}", deadline=(base + timedelta(days=days)).strftime("%Y-%m-%dZ"))
        )
    no_deadline = raw_notice(title="no deadline")
    no_deadline.pop("deadline-receipt-tender-date-lot")
    store(no_deadline)

    seen, cursor = [], None
    while True:
        params = {"sort": "deadline", "limit": 2, **({"cursor": cursor} if cursor else {})}
        page = client.get("/v1/notices", params=params, headers=headers(user)).json()
        seen += [n["title"] for n in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert seen == ["due in 10", "due in 25", "due in 40", "no deadline"]

    published = client.get("/v1/notices", params={"sort": "published"}, headers=headers(user))
    assert published.status_code == 200 and len(published.json()["items"]) == 4
    assert client.get("/v1/notices", params={"sort": "price"}, headers=headers(user)).status_code == 422


def test_ingestion_runs_report_skipped_notices(client, make_org):
    user = make_org()["user_id"]
    with owner_session() as s:
        s.execute(
            text(
                "INSERT INTO ingestion_runs (source, status, notices_seen, notices_new, notices_updated, "
                "notices_skipped) VALUES ('ted', 'success', 10, 6, 1, 3)"
            )
        )
    runs = client.get("/v1/ingestion-runs", headers=headers(user)).json()
    assert runs[0]["notices_skipped"] == 3


# ------------------------------------------------------------------ action schemas for the web app
def test_action_schema_file_matches_the_payload_models():
    from tenderline.agent.schema import PAYLOAD_MODELS

    committed = json.loads((REPO / "frontend" / "src" / "api" / "action-schemas.json").read_text(encoding="utf-8"))
    assert committed == {action: model.model_json_schema() for action, model in PAYLOAD_MODELS.items()}, (
        "run `uv run tenderline action-schemas` and commit the result"
    )


def test_reviewer_cannot_read_another_tenant_via_org_list(client, make_org):
    org = make_org()
    reviewer = add_member(org["org_id"], "reviewer")
    names = [o["name"] for o in client.get("/v1/organisations", headers=headers(reviewer)).json()]
    assert names == ["Acme Ltd"]
