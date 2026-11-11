import copy
import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from tenderline import notices as N
from tenderline.api.app import create_app
from tenderline.db import owner_session, public_session
from tenderline.matching import match_notice
from tenderline.security import create_token
from tenderline.ted.parse import parse_ted_notice

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "ted"


def H(uid, key=None):
    h = {"Authorization": f"Bearer {create_token(uid)}"}
    if key:
        h["Idempotency-Key"] = key
    return h


@pytest.fixture()
def client(migrated_db):
    with owner_session() as s:
        s.execute(text("ALTER TABLE notice_versions DISABLE TRIGGER USER"))
        s.execute(
            text(
                "TRUNCATE notices, notice_versions, lots, notice_cpv, buyers, cpv_codes, matches, saved_searches CASCADE"
            )
        )
        s.execute(text("ALTER TABLE notice_versions ENABLE TRIGGER USER"))
    with TestClient(create_app()) as c:
        yield c


def open_notice(title="Cloud hosting services", cpv=("72200000",), value="100000", deadline="2031-12-16Z"):
    raw = copy.deepcopy(json.loads((FIX / "cn_recent_page1.json").read_text(encoding="utf-8"))["notices"][0])
    raw.update(
        {
            "publication-number": f"{uuid.uuid4().int % 10**6}-2026",
            "notice-identifier": str(uuid.uuid4()),
            "notice-title": {"eng": title},
            "classification-cpv": list(cpv),
            "estimated-value-lot": [value],
            "estimated-value-cur-lot": ["EUR"],
            "deadline-receipt-tender-date-lot": [deadline],
            "buyer-country": ["IRL"],
        }
    )
    with public_session() as db:
        return N.store_notice(db, parse_ted_notice(raw)).notice_id, raw


def mk_search(client, org, user, key, **body):
    body = {"name": "s", **body}
    return client.post(f"/v1/organisations/{org}/saved-searches", json=body, headers=H(user, key))


def test_saved_search_validation(client, make_org):
    a = make_org()
    url = f"/v1/organisations/{a['org_id']}/saved-searches"
    assert client.post(url, json={"name": "empty"}, headers=H(a["user_id"], "k-empty-001")).status_code == 422
    assert mk_search(client, a["org_id"], a["user_id"], "k-badcpv-01", cpv_codes=["72x"]).status_code == 422
    assert (
        mk_search(client, a["org_id"], a["user_id"], "k-badctry-1", countries=["IE"], keywords=["a"]).status_code == 422
    )
    r = mk_search(client, a["org_id"], a["user_id"], "k-range-001", keywords=["a"], min_value=10, max_value=5)
    assert r.status_code == 422
    assert client.post(url, json={"name": "x", "keywords": ["a"]}, headers=H(a["user_id"])).status_code == 422  # no key


def test_saved_search_crud_roles_and_idempotency(client, make_org):
    a = make_org()
    org, owner = a["org_id"], a["user_id"]
    r1 = mk_search(client, org, owner, "k-create-001", cpv_codes=["72000000"], countries=["irl"], name="IT")
    r2 = mk_search(client, org, owner, "k-create-001", cpv_codes=["72000000"], countries=["irl"], name="IT")
    assert r1.status_code == 201 and r1.json()["countries"] == ["IRL"] and r2.json()["id"] == r1.json()["id"]
    sid = r1.json()["id"]
    assert len(client.get(f"/v1/organisations/{org}/saved-searches", headers=H(owner)).json()["items"]) == 1
    r = client.patch(f"/v1/organisations/{org}/saved-searches/{sid}", json={"active": False}, headers=H(owner))
    assert r.json()["active"] is False
    with owner_session() as s:
        viewer = uuid.uuid4()
        s.execute(text("INSERT INTO users (id, login) VALUES (:i, :l)"), {"i": viewer, "l": f"v-{viewer.hex[:6]}"})
        s.execute(
            text("INSERT INTO memberships (organisation_id, user_id, role) VALUES (:o,:u,'viewer')"),
            {"o": org, "u": viewer},
        )
    assert client.get(f"/v1/organisations/{org}/saved-searches", headers=H(viewer)).status_code == 200
    assert mk_search(client, org, viewer, "k-viewer-001", keywords=["x"]).status_code == 403
    assert client.delete(f"/v1/organisations/{org}/saved-searches/{sid}", headers=H(viewer)).status_code == 403
    assert client.delete(f"/v1/organisations/{org}/saved-searches/{sid}", headers=H(owner)).status_code == 204
    with owner_session() as s:
        actions = [
            r[0]
            for r in s.execute(text("SELECT action FROM audit_log WHERE organisation_id=:o ORDER BY id"), {"o": org})
        ]
    assert actions == ["saved_search.created", "saved_search.updated", "saved_search.deleted"]


def test_matching_creates_matches_per_tenant_with_reasons_and_audit(client, make_org):
    a, b, c = make_org("Org A"), make_org("Org B"), make_org("Org C")
    mk_search(client, a["org_id"], a["user_id"], "k-a-0000001", cpv_codes=["72000000"], keywords=["cloud"])
    mk_search(client, b["org_id"], b["user_id"], "k-b-0000001", cpv_codes=["45000000"])  # different sector
    nid, _ = open_notice()
    match_notice(nid)  # the saved-search backfill may already have matched it; assert the end state below
    ma = client.get(f"/v1/organisations/{a['org_id']}/matches", headers=H(a["user_id"])).json()["items"]
    assert len(ma) == 1 and ma[0]["reasons"]["cpv"] == ["72200000"] and ma[0]["reasons"]["keywords"] == ["cloud"]
    assert ma[0]["notice_title"] == "Cloud hosting services" and ma[0]["qualified_at"] is None
    # tenant isolation: B and C see nothing, and cannot fetch A's match by id
    assert client.get(f"/v1/organisations/{b['org_id']}/matches", headers=H(b["user_id"])).json()["items"] == []
    assert (
        client.get(f"/v1/organisations/{b['org_id']}/matches/{ma[0]['id']}", headers=H(b["user_id"])).status_code == 404
    )
    assert (
        client.get(f"/v1/organisations/{a['org_id']}/matches/{ma[0]['id']}", headers=H(c["user_id"])).status_code == 404
    )
    with owner_session() as s:
        row = s.execute(
            text(
                "SELECT actor_type, actor_id, action FROM audit_log WHERE action='match.created' AND organisation_id=:o"
            ),
            {"o": a["org_id"]},
        ).one()
    assert row == ("agent", "matcher-v1", "match.created")


def test_matching_is_idempotent_and_refreshes_on_new_version(client, make_org):
    a = make_org()
    mk_search(client, a["org_id"], a["user_id"], "k-a-0000002", keywords=["cloud"])
    nid, raw = open_notice()
    assert len(match_notice(nid)) == 1
    assert match_notice(nid) == []  # nothing new on a re-run
    changed = copy.deepcopy(raw)
    changed["estimated-value-lot"] = ["900000"]
    with public_session() as db:
        assert N.store_notice(db, parse_ted_notice(changed)).version == 2
    pairs = match_notice(nid)
    assert len(pairs) == 1  # existing match refreshed for re-qualification
    m = client.get(f"/v1/organisations/{a['org_id']}/matches", headers=H(a["user_id"])).json()["items"]
    assert len(m) == 1 and m[0]["notice_version"] == 2
    with owner_session() as s:
        assert s.execute(text("SELECT count(*) FROM audit_log WHERE action='match.refreshed'")).scalar() == 1


def test_inactive_searches_and_closed_notices_do_not_match(client, make_org):
    a = make_org()
    r = mk_search(client, a["org_id"], a["user_id"], "k-a-0000003", keywords=["cloud"])
    client.patch(
        f"/v1/organisations/{a['org_id']}/saved-searches/{r.json()['id']}",
        json={"active": False},
        headers=H(a["user_id"]),
    )
    nid, _ = open_notice()
    assert match_notice(nid) == []
    client.patch(
        f"/v1/organisations/{a['org_id']}/saved-searches/{r.json()['id']}",
        json={"active": True},
        headers=H(a["user_id"]),
    )
    past, _ = open_notice(title="Cloud expired", deadline="2020-01-01Z")
    assert match_notice(past) == []
    match_notice(nid)  # re-activation may already have backfilled this match (async): assert the end state
    listed = client.get(f"/v1/organisations/{a['org_id']}/matches", headers=H(a["user_id"])).json()["items"]
    assert [m["notice_id"] for m in listed] == [str(nid)]


def test_match_filters(client, make_org):
    a = make_org()
    s1 = mk_search(client, a["org_id"], a["user_id"], "k-a-0000004", keywords=["cloud"], name="cloud").json()["id"]
    mk_search(client, a["org_id"], a["user_id"], "k-a-0000005", keywords=["hosting"], name="hosting")
    nid, _ = open_notice()
    match_notice(nid)
    url = f"/v1/organisations/{a['org_id']}/matches"
    assert len(client.get(url, headers=H(a["user_id"])).json()["items"]) == 2
    assert len(client.get(f"{url}?saved_search_id={s1}", headers=H(a["user_id"])).json()["items"]) == 1
    assert client.get(f"{url}?qualified=true", headers=H(a["user_id"])).json()["items"] == []
    assert len(client.get(f"{url}?limit=1", headers=H(a["user_id"])).json()["items"]) == 1
