"""DBOS workflows and steps.

Determinism rules (from the DBOS docs): workflow bodies only branch on step results; anything that touches the
database, the clock, the network or randomness lives in a step.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from typing import Any

from dbos import DBOS, SetWorkflowID
from sqlalchemy import select, text, update

from tenderline.agent.qualify import AgentUnavailable, qualify_match
from tenderline.agent.tools import run_proposal
from tenderline.audit import write_audit
from tenderline.config import get_settings
from tenderline.db import public_session, tenant_session
from tenderline.faults import maybe_crash
from tenderline.matching import backfill_org, match_notice
from tenderline.models import AgentProposal, Deadline, Notice, Opportunity, Organisation
from tenderline.notices import finish_run, ingest_batch, last_cursor, last_success_date, normalise_name, start_run
from tenderline.observability import continue_trace, record_ingested, record_workflow_failure, tracer
from tenderline.opportunities import CLOSED, change_status
from tenderline.ted.client import TedClient, TedExpiredToken
from tenderline.ted.query import build_ingest_query

log = logging.getLogger(__name__)

QUEUE_ENRICH = "enrich"
QUEUE_QUALIFY = "qualify"
QUEUE_INGEST = "ingest"
EVENTS_TOPIC = "events"


@lru_cache
def _ted_client() -> TedClient:
    s = get_settings()
    return TedClient(s.ted_base_url, max_requests_per_minute=s.ted_max_requests_per_minute, page_size=s.ted_page_size)


def reset_ted_client() -> None:
    _ted_client.cache_clear()


# ===================================================================== 1. scheduled ingestion
@DBOS.step(retries_allowed=True, max_attempts=4, interval_seconds=5, backoff_rate=2.0)
def start_run_step(since_iso: str | None) -> dict[str, Any]:
    """Resume the unfinished run's cursor if there is one, otherwise open a new run."""
    s = get_settings()
    resume = last_cursor("ted")
    if resume and resume["cursor"] and resume["cursor"].get("token"):
        c = resume["cursor"]
        return {
            "run_id": resume["run_id"],
            "token": c["token"],
            "page": int(c.get("page", 0)),
            "query": c["query"],
            "resumed": True,
        }
    since = (
        date.fromisoformat(since_iso)
        if since_iso
        else (
            (last_success_date("ted") or date.today()) - timedelta(days=s.ted_lookback_days)  # noqa: DTZ011
        )
    )
    query = build_ingest_query(s.ted_country, since, s.extra_cpv_prefixes)
    run_id = start_run("ted", since, DBOS.workflow_id)
    return {"run_id": str(run_id), "token": None, "page": 0, "query": query, "resumed": False}


# No DBOS retries here: the TED client already retries with backoff, and a failed run resumes from its cursor.
@DBOS.step()
def ingest_page_step(run_id: str, query: str, token: str | None, page_no: int) -> dict[str, Any]:
    """Fetch one page and store it; the cursor moves in the same transaction as the data."""
    try:
        with tracer().start_as_current_span("ted.search_page", attributes={"ted.page": page_no}):
            page = _ted_client().search_page(query, token=token)
    except TedExpiredToken:
        return {"expired": True, "events": [], "next_token": None, "count": 0}
    events = ingest_batch(uuid.UUID(run_id), page.notices, page.next_token, page_no, query)
    record_ingested(sum(1 for e in events if e["action"] == "new"), "ted")
    return {"expired": False, "events": events, "next_token": page.next_token, "count": len(page.notices)}


@DBOS.step()
def finish_run_step(run_id: str, status: str, error: str | None) -> None:
    finish_run(uuid.UUID(run_id), status, error)


@DBOS.workflow()
def ingest_ted_workflow(since_iso: str | None = None) -> dict[str, Any]:
    """Ingest TED notices. Resumes from the last cursor and is safe to re-run (stores are idempotent)."""
    s = get_settings()
    st = start_run_step(since_iso)
    run_id, token, page_no, query = st["run_id"], st["token"], st["page"], st["query"]
    pages = events_total = 0
    exhausted = False
    restarts = 0
    try:
        while pages < s.ingest_max_pages:
            res = ingest_page_step(run_id, query, token, page_no + 1)
            if res["expired"]:  # TED point-in-time expired: restart the window; stores are idempotent
                restarts += 1
                if restarts > 1:
                    raise RuntimeError("TED iteration token expired twice in one run")
                token, page_no = None, 0
                continue
            if not res["count"]:  # an empty page is TED's end-of-results signal
                exhausted = True
                break
            for ev in res["events"]:
                DBOS.enqueue_workflow(QUEUE_ENRICH, process_notice_workflow, ev)
            events_total += len(res["events"])
            pages += 1
            page_no += 1
            token = res["next_token"]
            if not token:
                exhausted = True
                break
        if exhausted:
            finish_run_step(run_id, "ok", None)
    except Exception as exc:
        finish_run_step(run_id, "error", f"{type(exc).__name__}: {exc}"[:1000])
        record_workflow_failure("ingest_ted_workflow")
        raise
    return {"run_id": run_id, "pages": pages, "events": events_total, "complete": exhausted, "resumed": st["resumed"]}


@DBOS.workflow()
def scheduled_ingestion(scheduled_time: datetime, context: Any) -> None:
    ingest_ted_workflow(None)


# ===================================================================== 2. enrichment + matching
@DBOS.step()
def match_step(notice_id: str) -> list[list[str]]:
    with tracer().start_as_current_span("queue.match_notice", attributes={"tenderline.notice_id": notice_id}):
        return [[str(o), str(m)] for o, m in match_notice(uuid.UUID(notice_id))]


def wake(workflow_id: str, msg_type: str) -> None:
    """Best-effort signal from inside a workflow: the opportunity workflow may not exist (yet) or may be done."""
    try:
        DBOS.send(workflow_id, {"type": msg_type}, EVENTS_TOPIC)
    except Exception:  # noqa: BLE001 - e.g. DBOSNonExistentWorkflowError; nothing to wake
        log.info("no opportunity workflow to wake: %s", workflow_id)


@DBOS.workflow()
def process_notice_workflow(event: dict[str, Any]) -> dict[str, Any]:
    """Queue worker: route one stored notice event (award / corrigendum / new call) and match it."""
    out: dict[str, Any] = {"notice_id": event["notice_id"]}
    if event["awarded_notice_ids"]:
        out["awards"] = award = award_step(event)
        for wid in award["wake"]:
            wake(wid, "status_changed")
    if event["kind"] != "call":
        return out
    if event["action"] == "updated":
        out["corrigendum"] = corr = corrigendum_step(event)
        for wid in corr["wake"]:
            wake(wid, "deadlines_changed")
    pairs = match_step(event["notice_id"])
    for org_id, match_id in pairs:
        DBOS.enqueue_workflow(QUEUE_QUALIFY, qualify_workflow, org_id, match_id)
    out["matches"] = len(pairs)
    return out


# ===================================================================== 3. qualification
@DBOS.step(
    retries_allowed=True,
    max_attempts=3,
    interval_seconds=5,
    backoff_rate=2.0,
    should_retry=lambda e: isinstance(e, AgentUnavailable),
)
def qualify_step(org_id: str, match_id: str, traceparent: str | None = None) -> dict[str, Any]:
    with continue_trace(
        traceparent, "queue.qualify_match", **{"tenderline.org_id": org_id, "tenderline.match_id": match_id}
    ):
        return qualify_match(uuid.UUID(org_id), uuid.UUID(match_id))


@DBOS.workflow()
def qualify_workflow(org_id: str, match_id: str, traceparent: str | None = None) -> dict[str, Any]:
    try:
        return qualify_step(org_id, match_id, traceparent)
    except Exception:
        record_workflow_failure("qualify_workflow")
        raise


# ===================================================================== approved-proposal execution
@DBOS.step()
def run_proposal_step(org_id: str, proposal_id: str, traceparent: str | None = None) -> dict[str, Any]:
    with continue_trace(traceparent, "workflow.execute_proposal", **{"tenderline.proposal_id": proposal_id}):
        res = run_proposal(uuid.UUID(org_id), uuid.UUID(proposal_id))
    maybe_crash("after_tool_commit")  # tests: die after the DB commit but before DBOS records the step
    return res


@DBOS.workflow()
def execute_proposal_workflow(org_id: str, proposal_id: str, traceparent: str | None = None) -> dict[str, Any]:
    """Workflow id == proposal id, so the action cannot be started twice."""
    res = run_proposal_step(org_id, proposal_id, traceparent)
    opp_id = (res.get("result") or {}).get("opportunity_id")
    if res["status"] == "executed" and opp_id:
        wid = opportunity_workflow_id(org_id, opp_id)
        with SetWorkflowID(wid):
            DBOS.start_workflow(opportunity_workflow, org_id, opp_id)
        DBOS.send(wid, {"type": "proposal_executed", "proposal_id": proposal_id}, EVENTS_TOPIC)
    return res


# ===================================================================== 4. opportunity workflow
@DBOS.step()
def opportunity_workflow_id(org_id: str, opp_id: str) -> str:
    with tenant_session(org_id) as db:
        wid = db.scalar(select(Opportunity.workflow_id).where(Opportunity.id == uuid.UUID(opp_id)))
    return str(wid or f"opp-{opp_id}")


@DBOS.step()
def load_state_step(org_id: str, opp_id: str) -> dict[str, Any]:
    with tenant_session(org_id) as db:
        opp = db.get(Opportunity, uuid.UUID(opp_id))
        if opp is None or opp.closed_at is not None or opp.status in CLOSED:
            return {"closed": True, "wait": 0.0}
        now = db.scalar(select(text("clock_timestamp()")))
        nxt = db.scalar(
            select(text("min(due_at)"))
            .select_from(Deadline)
            .where(Deadline.opportunity_id == opp.id, Deadline.fired_at.is_(None))
        )
    cap = get_settings().opportunity_max_wait_seconds
    wait = cap if nxt is None else (nxt - now).total_seconds()
    return {"closed": False, "wait": float(max(0.0, min(wait, cap)))}


@DBOS.step()
def apply_message_step(org_id: str, opp_id: str, msg: dict[str, Any]) -> None:
    if msg.get("type") == "proposal_executed":
        with tenant_session(org_id) as db:
            opp = db.get(Opportunity, uuid.UUID(opp_id))
            if opp is not None:
                opp.flags = {**opp.flags, "last_proposal_executed": msg.get("proposal_id")}


@DBOS.step()
def fire_due_step(org_id: str, opp_id: str) -> list[str]:
    """Mark due deadlines/reminders as fired exactly once (row lock + fired_at) and audit each."""
    fired: list[str] = []
    with (
        tracer().start_as_current_span("workflow.fire_due", attributes={"tenderline.opportunity_id": opp_id}),
        tenant_session(org_id) as db,
    ):
        rows = db.scalars(
            select(Deadline)
            .where(
                Deadline.opportunity_id == uuid.UUID(opp_id),
                Deadline.fired_at.is_(None),
                Deadline.due_at <= text("clock_timestamp()"),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for d in rows:
            d.fired_at = datetime.now(UTC)
            action = "reminder.fired" if d.kind != "submission" else "deadline.passed"
            write_audit(
                db,
                uuid.UUID(org_id),
                actor_type="agent",
                actor_id="scheduler",
                action=action,
                entity_type="deadline",
                entity_id=d.id,
                after={"kind": d.kind, "due_at": d.due_at.isoformat(), "note": d.note, "opportunity_id": opp_id},
            )
            fired.append(str(d.id))
    return fired


@DBOS.workflow()
def opportunity_workflow(org_id: str, opp_id: str) -> str:
    """One per opportunity: durable timer until the next reminder/deadline, woken early by signals.

    `DBOS.recv(timeout)` is the durable timer: its wake-up time is checkpointed, so a restart neither loses nor
    repeats it. Approval/execution, status and corrigendum signals arrive on the same topic.
    """
    while True:
        st = load_state_step(org_id, opp_id)
        if st["closed"]:
            return "closed"
        msg = DBOS.recv(EVENTS_TOPIC, timeout_seconds=st["wait"])
        if msg is not None:
            apply_message_step(org_id, opp_id, msg)
            continue
        fire_due_step(org_id, opp_id)


# ===================================================================== 5. corrigendum handling
@DBOS.step()
def corrigendum_step(event: dict[str, Any]) -> dict[str, Any]:
    with tracer().start_as_current_span(
        "workflow.corrigendum", attributes={"tenderline.notice_id": event["notice_id"]}
    ):
        return _corrigendum(event)


def _corrigendum(event: dict[str, Any]) -> dict[str, Any]:
    notice_id, version, changes = uuid.UUID(event["notice_id"]), int(event["version"]), event.get("changes") or {}
    with public_session() as db:
        org_ids = [r[0] for r in db.execute(text("SELECT org_id FROM app_orgs_for_notice(:n)"), {"n": notice_id})]
        new_deadline = db.scalar(select(Notice.deadline_at).where(Notice.id == notice_id))
    summary: dict[str, Any] = {"orgs": len(org_ids), "cancelled": 0, "flagged": 0, "wake": []}
    flagged_fields = sorted(set(changes) & {"deadline_at", "estimated_value"})
    for org_id in org_ids:
        wake: str | None = None
        with tenant_session(org_id) as db:
            stale = db.scalars(
                select(AgentProposal).where(
                    AgentProposal.notice_id == notice_id,
                    AgentProposal.status == "pending",
                    AgentProposal.notice_version < version,
                )
            ).all()
            for p in stale:
                p.status = "cancelled"
                write_audit(
                    db,
                    org_id,
                    actor_type="agent",
                    actor_id="corrigendum-handler",
                    action="proposal.cancelled",
                    entity_type="agent_proposal",
                    entity_id=p.id,
                    before={"status": "pending", "notice_version": p.notice_version},
                    after={"status": "cancelled", "reason": "notice corrected", "new_version": version},
                )
            summary["cancelled"] += len(stale)
            opp = db.scalars(select(Opportunity).where(Opportunity.notice_id == notice_id)).first()
            if opp is not None and flagged_fields:
                opp.flags = {
                    **opp.flags,
                    "notice_changed": {
                        "fields": flagged_fields,
                        "version": version,
                        "changes": {k: changes[k] for k in flagged_fields},
                        "at": datetime.now(UTC).isoformat(),
                    },
                }
                if "deadline_at" in flagged_fields and new_deadline is not None:
                    sub = db.scalars(
                        select(Deadline).where(
                            Deadline.opportunity_id == opp.id,
                            Deadline.kind == "submission",
                            Deadline.source == "notice",
                        )
                    ).first()
                    if sub is not None:
                        sub.due_at, sub.fired_at = new_deadline, None
                write_audit(
                    db,
                    org_id,
                    actor_type="agent",
                    actor_id="corrigendum-handler",
                    action="opportunity.flagged_changed",
                    entity_type="opportunity",
                    entity_id=opp.id,
                    after={"fields": flagged_fields, "version": version},
                )
                summary["flagged"] += 1
                wake = opp.workflow_id
        if wake:
            summary["wake"].append(wake)
    return summary


# ===================================================================== 6. award handling
@DBOS.step()
def award_step(event: dict[str, Any]) -> dict[str, Any]:
    with tracer().start_as_current_span("workflow.award", attributes={"tenderline.notice_id": event["notice_id"]}):
        return _award(event)


def _award(event: dict[str, Any]) -> dict[str, Any]:
    closed = 0
    wake_ids: list[str] = []
    for nid in event["awarded_notice_ids"]:
        notice_id = uuid.UUID(nid)
        with public_session() as db:
            award = db.scalar(select(Notice.award).where(Notice.id == notice_id)) or {}
            org_ids = [r[0] for r in db.execute(text("SELECT org_id FROM app_orgs_for_notice(:n)"), {"n": notice_id})]
        winners = [normalise_name(w) for w in award.get("winners", [])]
        for org_id in org_ids:
            wake: str | None = None
            with tenant_session(org_id) as db:
                for p in db.scalars(
                    select(AgentProposal).where(AgentProposal.notice_id == notice_id, AgentProposal.status == "pending")
                ).all():
                    p.status = "cancelled"
                    write_audit(
                        db,
                        org_id,
                        actor_type="agent",
                        actor_id="award-handler",
                        action="proposal.cancelled",
                        entity_type="agent_proposal",
                        entity_id=p.id,
                        after={"reason": "contract awarded"},
                    )
                opp = db.scalars(select(Opportunity).where(Opportunity.notice_id == notice_id)).first()
                if opp is None or opp.status in CLOSED:
                    continue
                org = db.get(Organisation, org_id)
                assert org is not None
                outcome = {"award": award, "source": "award notice"}
                if opp.status == "submitted":
                    ours = normalise_name(org.name)
                    won = bool(ours) and any(ours == w or ours in w or w in ours for w in winners if w)
                    outcome["matched_by"] = "organisation name"
                    change_status(
                        db,
                        org_id,
                        opp,
                        "won" if won else "lost",
                        actor_type="agent",
                        actor_id="award-handler",
                        outcome=outcome,
                        reason="award notice published",
                    )
                else:
                    change_status(
                        db,
                        org_id,
                        opp,
                        "no_bid",
                        actor_type="agent",
                        actor_id="award-handler",
                        force=True,
                        outcome=outcome,
                        reason="contract awarded before a bid was submitted",
                    )
                closed += 1
                wake = opp.workflow_id
            if wake:
                wake_ids.append(wake)
        with public_session() as db:
            db.execute(update(Notice).where(Notice.id == notice_id).values(status="awarded"))
    return {"closed_opportunities": closed, "wake": wake_ids}


# ============================================== reconciler (crash window between commit and start)
@DBOS.step()
def stale_approved_step(older_than_seconds: int) -> list[list[str]]:
    with public_session() as db:
        rows = db.execute(
            text("SELECT org_id, proposal_id FROM app_stale_approved_proposals(make_interval(secs => :s))"),
            {"s": older_than_seconds},
        ).all()
    return [[str(o), str(p)] for o, p in rows]


@DBOS.workflow()
def reconcile_approvals(scheduled_time: datetime, context: Any) -> None:
    """Approved proposals whose execution never started get started now. The workflow id is the proposal id,
    so this can never run an action twice."""
    for org_id, proposal_id in stale_approved_step(60):
        with SetWorkflowID(f"exec-{proposal_id}"):
            DBOS.start_workflow(execute_proposal_workflow, org_id, proposal_id)


# ===================================================================== saved-search backfill
@DBOS.step()
def backfill_step(org_id: str, traceparent: str | None = None) -> list[str]:
    with continue_trace(traceparent, "queue.backfill_matches", **{"tenderline.org_id": org_id}):
        return [str(m) for m in backfill_org(uuid.UUID(org_id))]


@DBOS.workflow()
def backfill_workflow(org_id: str, search_id: str, traceparent: str | None = None) -> dict[str, Any]:
    """A new/changed saved search is matched against notices already in the database, then qualified.
    The request's trace context rides along, so API -> enrich queue -> qualify queue -> LLM is one trace."""
    match_ids = backfill_step(org_id, traceparent)
    for match_id in match_ids:
        DBOS.enqueue_workflow(QUEUE_QUALIFY, qualify_workflow, org_id, match_id, traceparent)
    return {"search_id": search_id, "new_or_refreshed_matches": len(match_ids)}
