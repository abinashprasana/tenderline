"""Seeding helpers shared by integration and workflow tests."""

from __future__ import annotations

import copy
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import text

from tenderline import notices as N
from tenderline.db import owner_session, public_session, tenant_session
from tenderline.matching import match_notice
from tenderline.ted.parse import parse_ted_notice

FIX = Path(__file__).resolve().parent / "fixtures" / "ted"


def quiesce_workflows(timeout: float = 45.0) -> None:
    """Let in-flight workflows finish and stop long-lived opportunity timers, so tests do not interfere."""
    from dbos import DBOS

    from tenderline.workflows import runtime

    if not runtime.is_running():
        return
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        active = DBOS.list_workflows(status=["ENQUEUED", "PENDING"], load_input=False, load_output=False)
        busy = [w for w in active if w.name != "opportunity_workflow"]
        for w in active:
            if w.name == "opportunity_workflow":
                DBOS.cancel_workflow(w.workflow_id)
        if not busy:
            return
        time.sleep(0.3)
    raise AssertionError("workflows did not quiesce")


def reset_notice_tables() -> None:
    quiesce_workflows()
    with owner_session() as s:
        s.execute(text("ALTER TABLE notice_versions DISABLE TRIGGER USER"))
        s.execute(text("ALTER TABLE audit_log DISABLE TRIGGER USER"))
        s.execute(
            text(
                "TRUNCATE notices, notice_versions, lots, notice_cpv, buyers, cpv_codes, matches, saved_searches, "
                "agent_proposals, approvals, opportunities, deadlines, llm_calls, audit_log, ingestion_runs, "
                "idempotency_keys CASCADE"
            )
        )
        s.execute(text("ALTER TABLE notice_versions ENABLE TRIGGER USER"))
        s.execute(text("ALTER TABLE audit_log ENABLE TRIGGER USER"))


def raw_notice(
    title="Cloud hosting and cyber security services",
    cpv=("72200000",),
    value="100000",
    deadline: str | None = None,
    buyer="Dublin City Council",
    notice_type="cn-standard",
) -> dict[str, Any]:
    raw = copy.deepcopy(json.loads((FIX / "cn_recent_page1.json").read_text(encoding="utf-8"))["notices"][0])
    if deadline is None:
        deadline = (datetime.now(UTC) + timedelta(days=30)).strftime("%Y-%m-%dZ")
    raw.update(
        {
            "publication-number": f"{uuid.uuid4().int % 10**6}-2026",
            "notice-identifier": str(uuid.uuid4()),
            "procedure-identifier": str(uuid.uuid4()),
            "notice-type": notice_type,
            "notice-title": {"eng": title},
            "description-lot": {"eng": ["Managed cloud hosting and security monitoring for a public body."]},
            "classification-cpv": list(cpv),
            "estimated-value-lot": [value],
            "estimated-value-cur-lot": ["EUR"],
            "deadline-receipt-tender-date-lot": [deadline],
            "buyer-country": ["IRL"],
            "buyer-name": {"eng": [buyer]},
        }
    )
    return raw


def store(raw: dict[str, Any]) -> N.StoreResult:
    with public_session() as db:
        return N.store_notice(db, parse_ted_notice(raw))


def set_profile(org_id: uuid.UUID, **profile: Any) -> None:
    with owner_session() as s:
        s.execute(
            text("UPDATE organisations SET profile = CAST(:p AS jsonb) WHERE id = :o"),
            {"p": json.dumps(profile), "o": org_id},
        )


def add_search(org_id: uuid.UUID, **kw: Any) -> uuid.UUID:
    sid = uuid.uuid4()
    with tenant_session(org_id) as db:
        db.execute(
            text(
                "INSERT INTO saved_searches (id, organisation_id, name, cpv_codes, keywords, countries) "
                "VALUES (:i, :o, 'test', :c, :k, :n)"
            ),
            {
                "i": sid,
                "o": org_id,
                "c": kw.get("cpv_codes", ["72000000"]),
                "k": kw.get("keywords", []),
                "n": kw.get("countries", []),
            },
        )
    return sid


def add_member(org_id: uuid.UUID, role: str) -> uuid.UUID:
    uid = uuid.uuid4()
    with owner_session() as s:
        s.execute(text("INSERT INTO users (id, login) VALUES (:i, :l)"), {"i": uid, "l": f"u-{uid.hex[:8]}"})
        s.execute(
            text("INSERT INTO memberships (organisation_id, user_id, role) VALUES (:o,:u,:r)"),
            {"o": org_id, "u": uid, "r": role},
        )
    return uid


def seed_match(org_id: uuid.UUID, **raw_kw: Any) -> tuple[uuid.UUID, uuid.UUID, dict[str, Any]]:
    """Org with a saved search + one open matching notice. Returns (notice_id, match_id, raw)."""
    add_search(org_id)
    raw = raw_notice(**raw_kw)
    res = store(raw)
    pairs = match_notice(res.notice_id)
    assert pairs, "seed notice should match"
    return res.notice_id, pairs[0][1], raw


def wait_for(fn, timeout=30.0, interval=0.3, message="condition"):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {message} (last={last!r})")


def audit_actions(org_id: uuid.UUID, entity_id: Any = None) -> list[str]:
    q = (
        "SELECT action FROM audit_log WHERE organisation_id=:o"
        + (" AND entity_id=:e" if entity_id else "")
        + " ORDER BY id"
    )
    with owner_session() as s:
        return [r[0] for r in s.execute(text(q), {"o": org_id, "e": str(entity_id) if entity_id else None})]
