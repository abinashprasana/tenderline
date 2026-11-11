import copy
import uuid

import pytest
from dbos import DBOS
from sqlalchemy import text

from tenderline.config import get_settings
from tenderline.db import owner_session
from tenderline.opportunities import ensure_opportunity
from tenderline.workflows import ingestion, maintenance, notice_events, qualification
from tenderline.workflows import runtime as rt
from tests.helpers import (
    add_search,
    audit_actions,
    quiesce_workflows,
    raw_notice,
    reset_notice_tables,
    set_profile,
    store,
    wait_for,
)
from tests.workflows.fake_ted import FakeTed

pytestmark = pytest.mark.workflow


def query_rows(sql, **p):
    with owner_session() as s:
        return s.execute(text(sql), p).all()


@pytest.fixture()
def ted(runtime, monkeypatch):
    reset_notice_tables()
    server = FakeTed().start()
    monkeypatch.setenv("TED_BASE_URL", server.url)
    get_settings.cache_clear()
    ingestion.reset_ted_client()
    yield server
    server.stop()
    quiesce_workflows()
    monkeypatch.delenv("TED_BASE_URL")
    get_settings.cache_clear()
    ingestion.reset_ted_client()


def run_ingest(since="2026-11-01"):
    return DBOS.start_workflow(ingestion.ingest_ted_workflow, since).get_result()


def test_ingestion_runs_end_to_end_from_ted_to_proposals(ted, make_org):
    org = make_org("Acme Hosting")
    set_profile(org["org_id"], capabilities=["training", "learning"], regions=["IRL"])
    add_search(org["org_id"], cpv_codes=[], keywords=[], countries=["IRL"])
    out = run_ingest()
    assert out["complete"] is True and out["pages"] == 2 and out["events"] == 4
    run = query_rows(
        "SELECT status, notices_seen, notices_new, cursor->>'page', window_from::text FROM ingestion_runs"
    )[0]
    assert run[0] == "ok" and run[1] == 4 and run[2] == 4 and run[4] == "2026-11-01"
    bodies = ted.requests
    assert "buyer-country=IRL" in bodies[0]["query"] and "publication-date>=20261101" in bodies[0]["query"]
    assert bodies[0]["paginationMode"] == "ITERATION" and "iterationNextToken" not in bodies[0]
    assert bodies[1]["iterationNextToken"] == ted.p1["iterationNextToken"]  # token chained into page 2
    assert query_rows("SELECT count(*) FROM notices WHERE source='ted'")[0][0] == 4
    # enrichment queue -> matching -> qualification queue -> proposals (all async)
    wait_for(lambda: query_rows("SELECT count(*) FROM matches")[0][0] == 4, message="4 matches")
    wait_for(
        lambda: query_rows("SELECT count(*) FROM matches WHERE qualified_at IS NOT NULL")[0][0] == 4,
        message="qualification",
    )
    assert query_rows("SELECT count(*) FROM agent_proposals WHERE status='pending'")[0][0] >= 4
    assert query_rows("SELECT count(*) FROM opportunities")[0][0] == 0  # still nothing executed without approval


def test_rerunning_ingestion_is_safe_and_creates_nothing_new(ted, make_org):
    org = make_org()
    add_search(org["org_id"], cpv_codes=[], keywords=[], countries=["IRL"])
    run_ingest()
    wait_for(
        lambda: query_rows("SELECT count(*) FROM matches WHERE qualified_at IS NOT NULL")[0][0] == 4,
        message="first run done",
    )
    quiesce_workflows()
    before = (
        query_rows("SELECT count(*) FROM notices")[0][0],
        query_rows("SELECT count(*) FROM agent_proposals")[0][0],
        query_rows("SELECT count(*) FROM notice_versions")[0][0],
    )
    run_ingest()
    quiesce_workflows()
    after = (
        query_rows("SELECT count(*) FROM notices")[0][0],
        query_rows("SELECT count(*) FROM agent_proposals")[0][0],
        query_rows("SELECT count(*) FROM notice_versions")[0][0],
    )
    assert before == after
    runs = query_rows("SELECT status, notices_new, notices_seen FROM ingestion_runs ORDER BY started_at")
    assert [r[0] for r in runs] == ["ok", "ok"] and runs[1][1] == 0 and runs[1][2] == 4


def test_ingestion_resumes_from_the_last_cursor(ted):
    # An earlier run died after page 1: its cursor holds the token for page 2.
    token = ted.p1["iterationNextToken"]
    with owner_session() as s:
        s.execute(
            text(
                "INSERT INTO ingestion_runs (source, window_from, status, cursor, notices_seen, notices_new) "
                "VALUES ('ted','2026-11-01','running', CAST(:c AS jsonb), 2, 2)"
            ),
            {"c": f'{{"token": "{token}", "page": 1, "query": "buyer-country=IRL AND publication-date>=20261101"}}'},
        )
    out = run_ingest()
    assert out["resumed"] is True and out["complete"] is True
    assert ted.requests[0]["iterationNextToken"] == token  # did not restart from page 1
    assert query_rows("SELECT count(*) FROM ingestion_runs")[0][0] == 1  # continued the same run row
    run = query_rows("SELECT status, notices_seen FROM ingestion_runs")[0]
    assert run == ("ok", 4)


def test_ingestion_failure_is_recorded_and_the_workflow_errors(ted):
    ted.fail_with = 400
    with pytest.raises(Exception, match="HTTP 400"):
        run_ingest()
    run = query_rows("SELECT status, error FROM ingestion_runs")[0]
    assert run[0] == "error" and "HTTP 400" in run[1]


def test_award_notice_closes_submitted_opportunities_with_outcome(runtime, make_org):
    reset_notice_tables()
    won, lost, idle = make_org("Acme Hosting Ltd"), make_org("Rival Systems"), make_org("Bystander Co")
    call = raw_notice()
    c = store(call)
    opps = {}
    for key, org, status in (("won", won, "submitted"), ("lost", lost, "submitted"), ("idle", idle, "bid")):
        from tenderline.db import tenant_session

        with tenant_session(org["org_id"]) as db:
            opp, _ = ensure_opportunity(db, org["org_id"], c.notice_id, actor_type="human", actor_id="u")
            opp.status = status
            opps[key] = opp.id
        with owner_session() as s:
            s.execute(
                text(
                    "INSERT INTO agent_proposals (organisation_id, notice_id, notice_version, action_type, payload, status)"
                    " VALUES (:o,:n,1,'mark_no_bid','{\"reason\":\"abc\"}','pending')"
                ),
                {"o": org["org_id"], "n": c.notice_id},
            )
    award = copy.deepcopy(raw_notice(notice_type="can-standard"))
    award.update(
        {
            "procedure-identifier": call["procedure-identifier"],
            "winner-name": {"eng": ["Acme Hosting Limited"]},
            "total-value": 95000,
            "winner-selection-status": ["selec-w"],
        }
    )
    res = store(award)
    assert res.awarded_notice_ids == [c.notice_id]
    out = DBOS.start_workflow(notice_events.process_notice_workflow, res.event()).get_result()
    assert out["awards"]["closed_opportunities"] == 3
    st = {
        r[0]: r[1:]
        for r in query_rows("SELECT id::text, status, outcome->>'matched_by', closed_at IS NOT NULL FROM opportunities")
    }
    assert st[str(opps["won"])] == ("won", "organisation name", True)
    assert st[str(opps["lost"])][0] == "lost" and st[str(opps["idle"])][0] == "no_bid"
    assert query_rows("SELECT status FROM notices WHERE id=:n", n=c.notice_id)[0][0] == "awarded"
    assert query_rows("SELECT count(*) FROM agent_proposals WHERE status='pending'")[0][0] == 0  # cancelled on award
    assert "opportunity.status_changed" in audit_actions(won["org_id"])


def test_opportunity_workflow_sleeps_then_fires_each_reminder_once_and_ends_when_closed(runtime, make_org):
    reset_notice_tables()
    org = make_org()
    n = store(raw_notice())
    from tenderline.db import tenant_session

    with tenant_session(org["org_id"]) as db:
        opp, _ = ensure_opportunity(db, org["org_id"], n.notice_id, actor_type="human", actor_id="u")
        opp_id, wid = opp.id, opp.workflow_id
        for secs, note in ((2, "first"), (5, "second")):
            db.execute(
                text(
                    "INSERT INTO deadlines (organisation_id, opportunity_id, kind, due_at, note, source) VALUES "
                    "(:o,:p,'reminder', now() + make_interval(secs => :s), :n,'human')"
                ),
                {"o": org["org_id"], "p": opp_id, "s": secs, "n": note},
            )
    rt.start_opportunity_workflow(org["org_id"], opp_id, wid)
    assert not query_rows("SELECT 1 FROM audit_log WHERE action='reminder.fired'")  # it is sleeping, not firing early
    wait_for(
        lambda: len(query_rows("SELECT 1 FROM audit_log WHERE action='reminder.fired'")) == 2,
        timeout=40,
        message="both reminders",
    )
    fired = query_rows("SELECT note, fired_at IS NOT NULL FROM deadlines WHERE kind='reminder' ORDER BY due_at")
    assert fired == [("first", True), ("second", True)]
    import time

    time.sleep(4)  # idle iterations must not re-fire anything
    assert len(query_rows("SELECT 1 FROM audit_log WHERE action='reminder.fired'")) == 2
    handle = DBOS.retrieve_workflow(wid)
    assert handle.get_status().status == "PENDING"  # still tracking until award / close
    # closing the opportunity (status change + signal) ends the workflow
    with owner_session() as s:
        s.execute(text("UPDATE opportunities SET status='no_bid', closed_at=now() WHERE id=:i"), {"i": opp_id})
    rt.notify_opportunity(wid, "status_changed")
    assert handle.get_result() == "closed"


def test_reconciler_starts_executions_that_never_started(runtime, make_org):
    from datetime import UTC, datetime

    from tests.helpers import seed_match

    reset_notice_tables()
    org = make_org()
    set_profile(org["org_id"], capabilities=["cloud hosting"], regions=["IRL"])
    notice_id, _, _ = seed_match(org["org_id"])
    pid = uuid.uuid4()
    with owner_session() as s:  # approved 5 minutes ago, but the process died before starting the workflow
        s.execute(
            text(
                "INSERT INTO agent_proposals (id, organisation_id, notice_id, notice_version, action_type, payload, status, decided_at)"
                " VALUES (:i,:o,:n,1,'create_opportunity','{}','approved', now() - interval '5 minutes')"
            ),
            {"i": pid, "o": org["org_id"], "n": notice_id},
        )
        s.execute(
            text(
                "INSERT INTO approvals (organisation_id, proposal_id, decision, decided_by) VALUES (:o,:i,'approved',:u)"
            ),
            {"o": org["org_id"], "i": pid, "u": org["user_id"]},
        )
    DBOS.start_workflow(maintenance.reconcile_approvals, datetime.now(UTC), "approvals").get_result()
    wait_for(
        lambda: query_rows("SELECT status FROM agent_proposals WHERE id=:i", i=pid)[0][0] == "executed",
        message="executed",
    )
    DBOS.start_workflow(
        maintenance.reconcile_approvals, datetime.now(UTC), "approvals"
    ).get_result()  # second pass: nothing to do
    assert query_rows("SELECT count(*) FROM opportunities")[0][0] == 1
    assert query_rows("SELECT count(*) FROM audit_log WHERE action='proposal.executed'")[0][0] == 1


def test_new_saved_search_backfills_notices_that_are_already_stored(runtime, make_org):
    reset_notice_tables()
    org = make_org("Acme Hosting")
    set_profile(org["org_id"], capabilities=["cloud hosting"], regions=["IRL"])
    store(raw_notice(title="Cloud hosting A"))
    store(raw_notice(title="Cloud hosting B"))
    store(raw_notice(title="Road works", cpv=("45233120",)))  # unrelated sector
    sid = add_search(org["org_id"], cpv_codes=["72000000"])  # created AFTER the notices were ingested
    out = DBOS.start_workflow(qualification.backfill_workflow, str(org["org_id"]), str(sid)).get_result()
    assert out["new_or_refreshed_matches"] == 2
    wait_for(
        lambda: query_rows("SELECT count(*) FROM matches WHERE qualified_at IS NOT NULL")[0][0] == 2,
        message="qualified",
    )
    assert query_rows("SELECT count(*) FROM agent_proposals WHERE status='pending'")[0][0] >= 2
    again = DBOS.start_workflow(qualification.backfill_workflow, str(org["org_id"]), str(sid)).get_result()
    assert again["new_or_refreshed_matches"] == 0  # idempotent


def test_backfill_caps_automatic_qualification(runtime, make_org, monkeypatch):
    reset_notice_tables()
    org = make_org("Acme Hosting")
    set_profile(org["org_id"], capabilities=["cloud hosting"], regions=["IRL"])
    for i in range(5):
        store(raw_notice(title=f"Cloud hosting {i}"))
    sid = add_search(org["org_id"], cpv_codes=["72000000"])
    monkeypatch.setenv("BACKFILL_QUALIFY_LIMIT", "2")
    get_settings.cache_clear()
    try:
        out = DBOS.start_workflow(qualification.backfill_workflow, str(org["org_id"]), str(sid)).get_result()
    finally:
        monkeypatch.delenv("BACKFILL_QUALIFY_LIMIT")
        get_settings.cache_clear()
    assert out["new_or_refreshed_matches"] == 5 and out["qualification_enqueued"] == 2
    wait_for(
        lambda: query_rows("SELECT count(*) FROM matches WHERE qualified_at IS NOT NULL")[0][0] == 2,
        message="2 qualified",
    )
    assert (
        query_rows("SELECT count(*) FROM matches")[0][0] == 5
    )  # the rest are matched, awaiting on-demand qualification
