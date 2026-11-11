import threading
import uuid

import pytest
from dbos import DBOS
from fastapi.testclient import TestClient
from sqlalchemy import text

from tenderline.agent.providers import FakeProvider
from tenderline.agent.qualify import qualify_match
from tenderline.agent.tools import ToolError, run_proposal
from tenderline.api.app import create_app
from tenderline.db import owner_session
from tenderline.security import create_token
from tests.helpers import (
    add_member,
    audit_actions,
    quiesce_workflows,
    reset_notice_tables,
    seed_match,
    set_profile,
    store,
    wait_for,
)

PROFILE = {
    "capabilities": ["cloud hosting", "cyber security"],
    "regions": ["IRL"],
    "min_contract_value": 10000,
    "max_contract_value": 500000,
}


def auth_headers(uid, key=None):
    h = {"Authorization": f"Bearer {create_token(uid)}"}
    if key:
        h["Idempotency-Key"] = key
    return h


def new_idempotency_key():
    return f"key-{uuid.uuid4().hex}"


@pytest.fixture()
def env(runtime, make_org):
    reset_notice_tables()
    a = make_org("Acme Hosting")
    set_profile(a["org_id"], **PROFILE)
    notice_id, match_id, raw = seed_match(a["org_id"])
    qualify_match(a["org_id"], match_id, [FakeProvider()])
    with TestClient(create_app()) as client:
        yield client, a, notice_id, match_id, raw
    quiesce_workflows()


def org_url(a):
    return f"/v1/organisations/{a['org_id']}"


def list_props(client, a, **q):
    qs = "&".join(f"{k_}={v}" for k_, v in q.items())
    return client.get(f"{org_url(a)}/agent-proposals?{qs}", headers=auth_headers(a["user_id"])).json()["items"]


def by_type(client, a, t):
    return next(p for p in list_props(client, a) if p["action_type"] == t)


def db_count(sql, **params):
    with owner_session() as s:
        return s.execute(text(sql), params).scalar()


def await_status(client, a, pid, status, timeout=30):
    return wait_for(
        lambda: (
            (p := client.get(f"{org_url(a)}/agent-proposals/{pid}", headers=auth_headers(a["user_id"])).json())
            and p["status"] == status
            and p
        ),
        timeout=timeout,
        message=f"proposal {status}",
    )


def test_proposals_are_pending_and_nothing_ran_before_approval(env):
    client, a, *_ = env
    props = list_props(client, a)
    assert props and all(p["status"] == "pending" and p["approval"] is None for p in props)
    assert db_count("SELECT count(*) FROM opportunities") == 0


def test_proposals_carry_notice_title_and_the_agents_assessment(env):
    client, a, notice_id, match_id, raw = env
    props = list_props(client, a)
    with owner_session() as s:
        after = s.execute(
            text("SELECT after FROM audit_log WHERE action = 'match.qualified' AND entity_id = :m"),
            {"m": str(match_id)},
        ).scalar_one()
    for p in props:
        assert p["notice_title"] == raw["notice-title"]["eng"]
        assert p["notice_deadline_at"] is not None
        assert p["assessment"] == {"reasons": after["reasons"], "risks": after["risks"]}
    assert props[0]["assessment"]["reasons"], "the fake provider gives reasons"


def test_approve_executes_the_action_and_audits_it(env):
    client, a, notice_id, *_ = env
    p = by_type(client, a, "create_opportunity")
    r = client.post(
        f"{org_url(a)}/agent-proposals/{p['id']}/approve",
        json={"comment": "looks right"},
        headers=auth_headers(a["user_id"], new_idempotency_key()),
    )
    assert r.status_code == 200 and r.json()["status"] == "approved" and r.json()["approval"]["decision"] == "approved"
    done = await_status(client, a, p["id"], "executed")
    assert done["result"]["created"] is True and done["executed_at"]
    opp = client.get(
        f"{org_url(a)}/opportunities/{done['result']['opportunity_id']}", headers=auth_headers(a["user_id"])
    ).json()
    assert opp["notice_id"] == str(notice_id) and opp["status"] == "new" and opp["workflow_id"].startswith("opp-")
    assert [d["kind"] for d in opp["deadlines"]] == ["submission"]
    listed = client.get(f"{org_url(a)}/opportunities?limit=50", headers=auth_headers(a["user_id"]))
    assert listed.status_code == 200 and listed.json()["items"][0]["notice_title"] == opp["notice_title"]
    actions = audit_actions(a["org_id"])
    assert {"proposal.created", "proposal.approved", "proposal.executed", "opportunity.created"} <= set(actions)
    with owner_session() as s:
        actor = s.execute(text("SELECT actor_type FROM audit_log WHERE action='proposal.approved'")).scalar()
    assert actor == "human"


def test_approved_reminders_create_deadlines_and_show_in_upcoming(env):
    client, a, *_ = env
    p = by_type(client, a, "add_deadline_reminders")
    client.post(
        f"{org_url(a)}/agent-proposals/{p['id']}/approve",
        json={},
        headers=auth_headers(a["user_id"], new_idempotency_key()),
    )
    done = await_status(client, a, p["id"], "executed")
    assert len(done["result"]["reminders"]) == 3
    up = client.get(f"{org_url(a)}/deadlines?within_days=40", headers=auth_headers(a["user_id"])).json()
    kinds = sorted(d["kind"] for d in up)
    assert kinds == ["reminder", "reminder", "reminder", "submission"]
    assert all(d["source"] in ("agent", "notice") for d in up)


def test_edit_then_approve_uses_the_edited_payload(env):
    client, a, *_ = env
    p = by_type(client, a, "add_deadline_reminders")
    bad = client.post(
        f"{org_url(a)}/agent-proposals/{p['id']}/edit-approve",
        json={"payload": {"days_before": [0]}},
        headers=auth_headers(a["user_id"], new_idempotency_key()),
    )
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_payload"
    assert (
        client.get(f"{org_url(a)}/agent-proposals/{p['id']}", headers=auth_headers(a["user_id"])).json()["status"]
        == "pending"
    )
    r = client.post(
        f"{org_url(a)}/agent-proposals/{p['id']}/edit-approve",
        json={"payload": {"days_before": [5]}},
        headers=auth_headers(a["user_id"], new_idempotency_key()),
    )
    assert r.status_code == 200 and r.json()["approval"]["decision"] == "edited"
    done = await_status(client, a, p["id"], "executed")
    assert len(done["result"]["reminders"]) == 1 and done["payload"] == {"days_before": [14, 7, 2]}  # original kept
    assert done["approval"]["edited_payload"] == {"days_before": [5]}


def test_reject_requires_a_reason_and_prevents_execution(env):
    client, a, *_ = env
    p = by_type(client, a, "create_opportunity")
    url = f"{org_url(a)}/agent-proposals/{p['id']}/reject"
    assert client.post(url, json={}, headers=auth_headers(a["user_id"], new_idempotency_key())).status_code == 422
    assert (
        client.post(url, json={"reason": "no"}, headers=auth_headers(a["user_id"], new_idempotency_key())).status_code
        == 422
    )
    r = client.post(
        url, json={"reason": "Outside our service area"}, headers=auth_headers(a["user_id"], new_idempotency_key())
    )
    assert (
        r.status_code == 200
        and r.json()["status"] == "rejected"
        and r.json()["approval"]["reason"] == "Outside our service area"
    )
    assert db_count("SELECT count(*) FROM opportunities") == 0
    again = client.post(
        f"{org_url(a)}/agent-proposals/{p['id']}/approve",
        json={},
        headers=auth_headers(a["user_id"], new_idempotency_key()),
    )
    assert again.status_code == 409 and again.json()["error"]["code"] == "already_decided"
    assert "proposal.rejected" in audit_actions(a["org_id"], p["id"])


def test_double_approve_runs_the_action_once(env):
    client, a, *_ = env
    p = by_type(client, a, "add_deadline_reminders")
    url = f"{org_url(a)}/agent-proposals/{p['id']}/approve"
    key = new_idempotency_key()
    first = client.post(url, json={}, headers=auth_headers(a["user_id"], key))
    replay = client.post(url, json={}, headers=auth_headers(a["user_id"], key))
    other_key = client.post(url, json={}, headers=auth_headers(a["user_id"], new_idempotency_key()))
    assert first.status_code == 200 and replay.status_code == 200 and replay.headers["Idempotent-Replay"] == "true"
    assert other_key.status_code == 409 and other_key.json()["error"]["code"] == "already_decided"
    await_status(client, a, p["id"], "executed")
    assert db_count("SELECT count(*) FROM deadlines WHERE kind='reminder'") == 3
    assert db_count("SELECT count(*) FROM approvals") == 1
    assert db_count("SELECT count(*) FROM audit_log WHERE action='proposal.executed'") == 1


def test_concurrent_approvals_only_one_wins(env):
    client, a, *_ = env
    p = by_type(client, a, "add_deadline_reminders")
    url = f"{org_url(a)}/agent-proposals/{p['id']}/approve"
    codes: list[int] = []
    barrier = threading.Barrier(4)

    def go():
        barrier.wait()
        codes.append(client.post(url, json={}, headers=auth_headers(a["user_id"], new_idempotency_key())).status_code)

    threads = [threading.Thread(target=go) for _ in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(codes) == [200, 409, 409, 409]
    await_status(client, a, p["id"], "executed")
    assert db_count("SELECT count(*) FROM deadlines WHERE kind='reminder'") == 3


def test_executing_twice_is_a_noop_the_second_time(env):
    client, a, *_ = env
    p = by_type(client, a, "add_deadline_reminders")
    pid = uuid.UUID(p["id"])
    with pytest.raises(ToolError):  # a pending (unapproved) proposal can never run
        run_proposal(a["org_id"], pid)
    client.post(
        f"{org_url(a)}/agent-proposals/{p['id']}/approve",
        json={},
        headers=auth_headers(a["user_id"], new_idempotency_key()),
    )
    await_status(client, a, p["id"], "executed")
    again = run_proposal(a["org_id"], pid)
    assert again["replayed"] is True and again["status"] == "executed"
    assert db_count("SELECT count(*) FROM deadlines WHERE kind='reminder'") == 3


def test_approve_after_corrigendum_is_refused_and_requalified(env):
    client, a, notice_id, match_id, raw = env
    from tenderline.workflows.notice_events import process_notice_workflow

    old = list_props(client, a)
    changed = dict(raw, **{"estimated-value-lot": ["450000"], "deadline-receipt-tender-date-lot": ["2031-02-02Z"]})
    res = store(changed)
    assert res.action == "updated" and set(res.changes) >= {"estimated_value", "deadline_at"}
    handle = DBOS.start_workflow(process_notice_workflow, res.event())
    out = handle.get_result()
    assert out["corrigendum"]["cancelled"] == len(old) and out["matches"] == 1
    for p in old:
        stale = client.get(f"{org_url(a)}/agent-proposals/{p['id']}", headers=auth_headers(a["user_id"])).json()
        assert stale["status"] == "cancelled"
        r = client.post(
            f"{org_url(a)}/agent-proposals/{p['id']}/approve",
            json={},
            headers=auth_headers(a["user_id"], new_idempotency_key()),
        )
        assert r.status_code == 409 and r.json()["error"]["code"] == "proposal_cancelled"
    assert db_count("SELECT count(*) FROM opportunities") == 0
    fresh = wait_for(
        lambda: [p for p in list_props(client, a, status="pending") if p["notice_version"] == 2],
        message="re-qualification for version 2",
    )
    assert fresh
    assert "proposal.cancelled" in audit_actions(a["org_id"])


def test_approve_in_the_race_window_before_cancellation_is_also_refused(env):
    client, a, _, _, raw = env
    p = by_type(client, a, "create_opportunity")
    store(dict(raw, **{"estimated-value-lot": ["777777"]}))  # corrigendum landed; handler has not run yet
    r = client.post(
        f"{org_url(a)}/agent-proposals/{p['id']}/approve",
        json={},
        headers=auth_headers(a["user_id"], new_idempotency_key()),
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "proposal_stale"
    assert (
        client.get(f"{org_url(a)}/agent-proposals/{p['id']}", headers=auth_headers(a["user_id"])).json()["status"]
        == "cancelled"
    )
    assert db_count("SELECT count(*) FROM opportunities") == 0


def test_roles_viewers_cannot_decide_reviewers_can(env):
    client, a, *_ = env
    viewer, reviewer = add_member(a["org_id"], "viewer"), add_member(a["org_id"], "reviewer")
    p = by_type(client, a, "create_opportunity")
    url = f"{org_url(a)}/agent-proposals/{p['id']}"
    assert client.get(url, headers=auth_headers(viewer)).status_code == 200
    assert (
        client.post(f"{url}/approve", json={}, headers=auth_headers(viewer, new_idempotency_key())).status_code == 403
    )
    assert (
        client.post(
            f"{url}/reject", json={"reason": "viewer"}, headers=auth_headers(viewer, new_idempotency_key())
        ).status_code
        == 403
    )
    assert (
        client.post(f"{url}/approve", json={}, headers=auth_headers(reviewer, new_idempotency_key())).status_code == 200
    )


def test_tenant_b_cannot_see_or_decide_tenant_a_proposals(env, make_org):
    client, a, *_ = env
    b = make_org("Rival Ltd")
    p = by_type(client, a, "create_opportunity")
    assert client.get(f"{org_url(b)}/agent-proposals", headers=auth_headers(b["user_id"])).json()["items"] == []
    assert client.get(f"{org_url(b)}/agent-proposals/{p['id']}", headers=auth_headers(b["user_id"])).status_code == 404
    assert (
        client.post(
            f"{org_url(b)}/agent-proposals/{p['id']}/approve",
            json={},
            headers=auth_headers(b["user_id"], new_idempotency_key()),
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"{org_url(a)}/agent-proposals/{p['id']}/approve",
            json={},
            headers=auth_headers(b["user_id"], new_idempotency_key()),
        ).status_code
        == 404
    )
    assert (
        client.get(f"{org_url(a)}/agent-proposals/{p['id']}", headers=auth_headers(a["user_id"])).json()["status"]
        == "pending"
    )


def test_missing_idempotency_key_is_rejected(env):
    client, a, *_ = env
    p = by_type(client, a, "create_opportunity")
    r = client.post(f"{org_url(a)}/agent-proposals/{p['id']}/approve", json={}, headers=auth_headers(a["user_id"]))
    assert r.status_code == 422


def test_failed_precondition_marks_proposal_failed_not_half_done(env):
    client, a, *_ = env
    reviewer = add_member(a["org_id"], "reviewer")
    # the agent proposed a reviewer who then leaves the organisation before anyone approves
    with owner_session() as s:
        pid = s.execute(text("SELECT id FROM agent_proposals WHERE action_type='assign_reviewer'")).scalar()
        s.execute(
            text("UPDATE agent_proposals SET payload = CAST(:p AS jsonb) WHERE id = :i"),
            {"i": pid, "p": f'{{"user_id": "{reviewer}"}}'},
        )
        s.execute(text("DELETE FROM memberships WHERE user_id=:u"), {"u": reviewer})
    client.post(
        f"{org_url(a)}/agent-proposals/{pid}/approve",
        json={},
        headers=auth_headers(a["user_id"], new_idempotency_key()),
    )
    failed = await_status(client, a, str(pid), "failed")
    assert "not a member" in failed["result"]["error"]
    assert db_count("SELECT count(*) FROM opportunities WHERE assigned_reviewer_id IS NOT NULL") == 0
