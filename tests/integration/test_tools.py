"""The typed tool layer, one test per tool: effects, preconditions, and exactly-once behaviour."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from tenderline.agent.tools import TOOLS, run_proposal
from tenderline.db import owner_session
from tests.helpers import add_member, raw_notice, reset_notice_tables, seed_match, set_profile, store


@pytest.fixture()
def world(make_org):
    reset_notice_tables()
    org = make_org("Acme Hosting")
    set_profile(org["org_id"], capabilities=["cloud hosting"], regions=["IRL"])
    notice_id, _, _ = seed_match(org["org_id"])  # deadline ~30 days out
    return org, notice_id


def approved(org, notice_id, action, payload):
    pid = uuid.uuid4()
    with owner_session() as s:
        s.execute(
            text(
                "INSERT INTO agent_proposals (id, organisation_id, notice_id, notice_version, action_type, payload, status,"
                " decided_at) VALUES (:i,:o,:n,1,:a,CAST(:p AS jsonb),'approved', now())"
            ),
            {"i": pid, "o": org["org_id"], "n": notice_id, "a": action, "p": __import__("json").dumps(payload)},
        )
        s.execute(
            text(
                "INSERT INTO approvals (organisation_id, proposal_id, decision, decided_by) VALUES (:o,:i,'approved',:u)"
            ),
            {"o": org["org_id"], "i": pid, "u": org["user_id"]},
        )
    return pid


def query_rows(sql, **p):
    with owner_session() as s:
        return s.execute(text(sql), p).all()


def test_exactly_the_five_documented_tools_exist():
    assert set(TOOLS) == {
        "create_opportunity",
        "add_deadline_reminders",
        "assign_reviewer",
        "draft_clarification_question",
        "mark_no_bid",
    }


def test_create_opportunity_is_get_or_create_and_adds_the_notice_deadline(world):
    org, notice_id = world
    r1 = run_proposal(org["org_id"], approved(org, notice_id, "create_opportunity", {}))
    r2 = run_proposal(org["org_id"], approved(org, notice_id, "create_opportunity", {"note": "again"}))
    assert r1["result"]["created"] is True and r2["result"]["created"] is False
    assert r1["result"]["opportunity_id"] == r2["result"]["opportunity_id"]
    assert query_rows("SELECT count(*) FROM opportunities")[0][0] == 1
    assert query_rows("SELECT kind, source FROM deadlines") == [("submission", "notice")]


def test_reminders_count_back_from_the_deadline_and_skip_past_ones(world):
    org, notice_id = world
    soon = (datetime.now(UTC) + timedelta(days=5)).strftime("%Y-%m-%dZ")
    from tests.helpers import raw_notice as rn

    near = store(rn(title="Cloud hosting near", deadline=soon)).notice_id
    res = run_proposal(org["org_id"], approved(org, near, "add_deadline_reminders", {"days_before": [14, 7, 2]}))
    assert res["status"] == "executed" and len(res["result"]["reminders"]) == 1 and res["result"]["skipped_past"] == 2
    far = run_proposal(org["org_id"], approved(org, notice_id, "add_deadline_reminders", {"days_before": [14, 7, 2]}))
    assert len(far["result"]["reminders"]) == 3
    assert query_rows("SELECT count(*) FROM deadlines WHERE kind='reminder' AND source='agent'")[0][0] == 4


def test_reminders_fail_cleanly_when_the_notice_has_no_deadline(world):
    org, _ = world
    from tests.helpers import raw_notice as rn

    raw = rn(title="Cloud hosting open ended")
    raw.pop("deadline-receipt-tender-date-lot")
    nid = store(raw).notice_id
    res = run_proposal(org["org_id"], approved(org, nid, "add_deadline_reminders", {"days_before": [7]}))
    assert res["status"] == "failed" and "no tender deadline" in res["result"]["error"]
    assert query_rows("SELECT count(*) FROM deadlines WHERE kind='reminder'")[0][0] == 0


def test_assign_reviewer_requires_a_reviewer_capable_member(world):
    org, notice_id = world
    reviewer, viewer = add_member(org["org_id"], "reviewer"), add_member(org["org_id"], "viewer")
    ok = run_proposal(org["org_id"], approved(org, notice_id, "assign_reviewer", {"user_id": str(reviewer)}))
    assert ok["status"] == "executed"
    assert query_rows("SELECT assigned_reviewer_id FROM opportunities")[0][0] == reviewer
    bad = run_proposal(org["org_id"], approved(org, notice_id, "assign_reviewer", {"user_id": str(viewer)}))
    assert bad["status"] == "failed" and query_rows("SELECT assigned_reviewer_id FROM opportunities")[0][0] == reviewer
    assert "opportunity.reviewer_assigned" in [r[0] for r in query_rows("SELECT action FROM audit_log")]


def test_draft_clarification_is_stored_as_a_draft_and_never_sent(world):
    org, notice_id = world
    res = run_proposal(
        org["org_id"],
        approved(
            org, notice_id, "draft_clarification_question", {"question": "Please confirm the evaluation weighting."}
        ),
    )
    assert res["status"] == "executed" and res["result"]["drafts"] == 1
    drafts = query_rows("SELECT flags->'clarification_drafts' FROM opportunities")[0][0]
    assert drafts[0]["status"] == "draft" and "evaluation weighting" in drafts[0]["question"]
    assert query_rows("SELECT count(*) FROM audit_log WHERE action LIKE '%sent%'")[0][0] == 0


def test_mark_no_bid_closes_the_opportunity_and_records_the_reason(world):
    org, notice_id = world
    res = run_proposal(org["org_id"], approved(org, notice_id, "mark_no_bid", {"reason": "Outside our region"}))
    assert res["status"] == "executed"
    status, closed, outcome = query_rows("SELECT status, closed_at IS NOT NULL, outcome->>'reason' FROM opportunities")[
        0
    ]
    assert (status, closed, outcome) == ("no_bid", True, "Outside our region")
    assert query_rows("SELECT actor_type FROM audit_log WHERE action='opportunity.status_changed'")[0][0] == "human"


def test_mark_no_bid_refuses_after_submission(world):
    org, notice_id = world
    run_proposal(org["org_id"], approved(org, notice_id, "create_opportunity", {}))
    with owner_session() as s:
        s.execute(text("UPDATE opportunities SET status='submitted'"))
    res = run_proposal(org["org_id"], approved(org, notice_id, "mark_no_bid", {"reason": "changed our mind"}))
    assert res["status"] == "failed" and query_rows("SELECT status FROM opportunities")[0][0] == "submitted"


def test_a_failing_tool_leaves_no_partial_writes(world):
    org, _ = world
    from tests.helpers import raw_notice as rn

    raw = rn(title="Cloud hosting no deadline")
    raw.pop("deadline-receipt-tender-date-lot")
    nid = store(raw).notice_id
    run_proposal(org["org_id"], approved(org, nid, "add_deadline_reminders", {"days_before": [7]}))
    # ensure_opportunity ran inside the failed tool; its rows must have been rolled back with the savepoint
    assert query_rows("SELECT count(*) FROM opportunities")[0][0] == 0
    assert raw_notice
