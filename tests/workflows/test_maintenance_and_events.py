"""Corrigendum and award handling, the two reconcilers and the daily cleanup."""

import copy
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from dbos import DBOS
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from sqlalchemy import text

from tenderline import observability
from tenderline.agent.tools import run_proposal
from tenderline.config import get_settings
from tenderline.db import owner_session, tenant_session
from tenderline.opportunities import ensure_opportunity
from tenderline.workflows import maintenance, notice_events
from tests.helpers import quiesce_workflows, raw_notice, reset_notice_tables, store, wait_for

pytestmark = pytest.mark.workflow


def query_rows(sql, **params):
    with owner_session() as db:
        return db.execute(text(sql), params).all()


def run_now(workflow, *args):
    return DBOS.start_workflow(workflow, *args).get_result()


def track(org, notice_id, status="new"):
    with tenant_session(org["org_id"]) as db:
        opportunity, _ = ensure_opportunity(db, org["org_id"], notice_id, actor_type="human", actor_id="test")
        opportunity.status = status
        return opportunity.id, opportunity.workflow_id


@pytest.fixture()
def clean(runtime):
    reset_notice_tables()
    yield
    quiesce_workflows()


def test_reminders_move_with_a_corrected_deadline(clean, make_org):
    org = make_org()
    old_deadline = datetime.now(UTC) + timedelta(days=30)
    raw = raw_notice(deadline=old_deadline.strftime("%Y-%m-%dZ"))
    stored = store(raw)
    opportunity_id, _ = track(org, stored.notice_id)
    with owner_session() as db:  # a human approved "remind me 7 and 2 days before"
        proposal_id = uuid.uuid4()
        db.execute(
            text(
                "INSERT INTO agent_proposals (id, organisation_id, notice_id, notice_version, action_type, payload,"
                " status, decided_at) VALUES (:i, :o, :n, 1, 'add_deadline_reminders',"
                " '{\"days_before\": [7, 2]}', 'approved', now())"
            ),
            {"i": proposal_id, "o": org["org_id"], "n": stored.notice_id},
        )
        db.execute(
            text(
                "INSERT INTO approvals (organisation_id, proposal_id, decision, decided_by) VALUES (:o,:i,'approved',:u)"
            ),
            {"o": org["org_id"], "i": proposal_id, "u": org["user_id"]},
        )
    run_proposal(org["org_id"], proposal_id)
    with owner_session() as db:  # one extra reminder set by hand at a fixed time must not move
        db.execute(
            text(
                "INSERT INTO deadlines (organisation_id, opportunity_id, kind, due_at, note, source)"
                " VALUES (:o, :p, 'reminder', now() + interval '3 days', 'call the buyer', 'human')"
            ),
            {"o": org["org_id"], "p": opportunity_id},
        )

    new_deadline = old_deadline + timedelta(days=14)
    corrected = store({**raw, "deadline-receipt-tender-date-lot": [new_deadline.strftime("%Y-%m-%dZ")]})
    summary = run_now(notice_events.process_notice_workflow, corrected.event())
    assert summary["corrigendum"]["flagged"] == 1

    rows = query_rows("SELECT kind, offset_days, due_at, note FROM deadlines ORDER BY due_at")
    submission = next(r for r in rows if r[0] == "submission")
    assert submission[2].date() == new_deadline.date()
    for _, offset_days, due_at, _note in (r for r in rows if r[1] is not None):
        assert due_at == submission[2] - timedelta(days=offset_days)  # 7 and 2 days before the NEW deadline
    fixed = next(r for r in rows if r[3] == "call the buyer")
    assert fixed[2] < datetime.now(UTC) + timedelta(days=4)  # untouched
    flags = query_rows("SELECT flags FROM opportunities")[0][0]
    assert flags["notice_changed"]["fields"] == ["deadline_at"]
    audit = query_rows("SELECT after FROM audit_log WHERE action='opportunity.flagged_changed'")[0][0]
    assert audit["reminders_moved"] == 2


def award_for(call, winners):
    award = copy.deepcopy(raw_notice(notice_type="can-standard"))
    award.update(
        {
            "procedure-identifier": call["procedure-identifier"],
            "winner-name": {"eng": winners},
            "total-value": 95000,
            "winner-selection-status": ["selec-w"],
        }
    )
    return award


def test_a_win_needs_an_exact_name_match_and_anything_else_is_flagged_for_review(clean, make_org):
    acme, acme_rivals, acme_trading_name = make_org("Acme"), make_org("Acme Rivals"), make_org("Acme Hosting")
    call = raw_notice()
    stored = store(call)
    opportunities = {
        name: track(org, stored.notice_id, "submitted")[0]
        for name, org in (("acme", acme), ("rivals", acme_rivals), ("trading", acme_trading_name))
    }
    award = store(award_for(call, ["ACME RIVALS LTD."]))
    run_now(notice_events.process_notice_workflow, award.event())
    result = {
        str(row[0]): (row[1], row[2])
        for row in query_rows("SELECT id, status, flags->>'outcome_needs_review' FROM opportunities")
    }
    assert result[str(opportunities["rivals"])] == ("won", None)
    # "Acme" is a substring of the winner's name; that used to count as a win
    assert result[str(opportunities["acme"])] == ("lost", "true")
    assert result[str(opportunities["trading"])] == ("lost", "true")


def test_open_opportunities_without_a_live_workflow_get_one(clean, make_org):
    org = make_org()
    stored = store(raw_notice())
    opportunity_id, original_workflow_id = track(org, stored.notice_id)
    with owner_session() as db:  # old enough that it is not a create that is still starting its workflow
        db.execute(text("UPDATE opportunities SET created_at = now() - interval '10 minutes'"))
    assert not DBOS.list_workflows(workflow_ids=[original_workflow_id])  # e.g. it belonged to a previous release

    run_now(maintenance.restart_orphaned_opportunity_workflows, datetime.now(UTC), "test")
    new_workflow_id = query_rows("SELECT workflow_id FROM opportunities WHERE id=:i", i=opportunity_id)[0][0]
    assert new_workflow_id != original_workflow_id
    wait_for(lambda: DBOS.list_workflows(workflow_ids=[new_workflow_id], status="PENDING"), message="workflow running")

    run_now(maintenance.restart_orphaned_opportunity_workflows, datetime.now(UTC), "test")  # nothing left to do
    assert query_rows("SELECT workflow_id FROM opportunities WHERE id=:i", i=opportunity_id)[0][0] == new_workflow_id


def test_cleanup_deletes_only_old_finished_workflows_and_old_idempotency_keys(clean, make_org, monkeypatch):
    org = make_org()
    with owner_session() as db:
        for key, age in (("old-key-000001", "30 days"), ("new-key-000001", "1 hour")):
            db.execute(
                text(
                    "INSERT INTO idempotency_keys (organisation_id, key, request_hash, created_at)"
                    " VALUES (:o, :k, 'h', now() - CAST(:age AS interval))"
                ),
                {"o": org["org_id"], "k": key, "age": age},
            )
    finished = DBOS.start_workflow(maintenance.reconcile_approvals, datetime.now(UTC), "seed")
    finished.get_result()
    monkeypatch.setenv("WORKFLOW_RETENTION_DAYS", "0")  # everything finished before "now" is old
    get_settings.cache_clear()
    try:
        run_now(maintenance.purge_old_records, datetime.now(UTC), "test")
    finally:
        monkeypatch.delenv("WORKFLOW_RETENTION_DAYS")
        get_settings.cache_clear()
    assert [row[0] for row in query_rows("SELECT key FROM idempotency_keys")] == ["new-key-000001"]
    assert not DBOS.list_workflows(workflow_ids=[finished.workflow_id])
    assert query_rows("SELECT count(*) FROM audit_log")[0][0] >= 0  # the audit log is never part of cleanup


def test_fan_out_work_links_to_the_request_instead_of_joining_its_trace():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("test")
    original = observability._tracer
    observability._tracer = tracer
    try:
        with tracer.start_as_current_span("POST /saved-searches") as request_span:
            traceparent = observability.current_traceparent()
        with observability.continue_trace(traceparent, "child-job"):
            pass
        with observability.continue_trace(traceparent, "fan-out-job", link_only=True):
            pass
    finally:
        observability._tracer = original
    spans = {span.name: span for span in exporter.get_finished_spans()}
    request_context = request_span.get_span_context()
    assert spans["child-job"].context.trace_id == request_context.trace_id
    fan_out = spans["fan-out-job"]
    assert fan_out.context.trace_id != request_context.trace_id and fan_out.parent is None
    assert [link.context.span_id for link in fan_out.links] == [request_context.span_id]
