"""End-to-end demo against a running stack (dev mode). Uses only the public API plus the ingestion trigger.

    docker compose exec app tenderline demo

It ingests REAL notices from TED (anonymous, paced), creates a demo organisation and saved search, waits for
matching and the agent's qualification, approves proposals as a human would, and prints the outcome.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx


def _say(msg: str) -> None:
    print(msg, flush=True)  # noqa: T201


def _step(n: int, title: str) -> None:
    _say(f"\n=== {n}. {title}")


def run_demo(base_url: str, since: str | None, cpvs: list[str], skip_ingest: bool) -> int:
    api = httpx.Client(base_url=base_url, timeout=60)
    stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")  # a fresh organisation per run

    def call(method: str, url: str, token: str | None = None, key: str | None = None, **kw: Any) -> httpx.Response:
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if key:
            headers["Idempotency-Key"] = key
        return api.request(method, url, headers=headers, **kw)

    _step(1, "Sign in (dev token; disabled unless ENV=dev)")
    r = call("POST", "/v1/auth/dev-token", json={"login": "demo-owner"})
    if r.status_code != 200:
        _say(f"dev token unavailable ({r.status_code}). Run with ENV=dev, or use GitHub OAuth (see SETUP.md).")
        return 1
    token = r.json()["access_token"]

    _step(2, "Create a demo organisation with a company profile")
    profile = {
        "description": "Irish IT and engineering services SME (demo profile)",
        "capabilities": [
            "software development",
            "cloud hosting",
            "cyber security",
            "digital transformation",
            "engineering consultancy",
        ],
        "regions": ["IRL"],
        "min_contract_value": 20000,
        "max_contract_value": 2_000_000,
    }
    org = call(
        "POST", "/v1/organisations", token, f"demo-org-{stamp}", json={"name": "Demo Bids Ltd", "profile": profile}
    ).json()
    org_id = org["id"]
    _say(f"organisation {org['name']} ({org_id})")
    r = call("POST", "/v1/auth/dev-token", json={"login": "demo-owner", "organisation_id": org_id, "role": "owner"})
    token = r.json()["access_token"]
    base = f"/v1/organisations/{org_id}"

    _step(3, f"Save a search: Irish buyers, CPV {', '.join(cpvs)}")
    r = call(
        "POST",
        f"{base}/saved-searches",
        token,
        f"demo-search-{stamp}",
        json={
            "name": "IT & engineering opportunities",
            "cpv_codes": [c.ljust(8, "0") for c in cpvs],
            "countries": ["IRL"],
        },
    )
    _say(f"saved search {r.json()['id']}")

    if not skip_ingest:
        _step(4, "Ingest real TED notices (Irish buyers, paced well below TED's 700 req/min limit)")
        from dbos import DBOSClient

        from tenderline.config import get_settings

        window = since or (date.today() - timedelta(days=14)).isoformat()  # noqa: DTZ011
        client = DBOSClient(system_database_url=get_settings().dbos_system_database_url, application_name="tenderline")
        handle: Any = client.enqueue({"queue_name": "ingest", "workflow_name": "ingest_ted_workflow"}, window)
        _say(f"ingestion workflow {handle.workflow_id} (window from {window})")
        end = time.monotonic() + 1200
        while time.monotonic() < end and handle.get_status().status not in ("SUCCESS", "ERROR", "CANCELLED"):
            time.sleep(3)
        st = handle.get_status().status
        _say(f"ingestion {st}: {json.dumps(handle.get_result(), default=str) if st == 'SUCCESS' else ''}")
        if st != "SUCCESS":
            return 1
    runs = call("GET", "/v1/ingestion-runs?limit=1", token).json()
    if runs:
        _say(f"last run: seen={runs[0]['notices_seen']} new={runs[0]['notices_new']} status={runs[0]['status']}")

    _step(5, "Wait for matching (enrichment queue) and agent qualification (qualify queue)")
    matches: list[dict[str, Any]] = []
    last_change = time.monotonic()
    end = time.monotonic() + 300
    while time.monotonic() < end:
        matches = call("GET", f"{base}/matches?limit=200", token).json()["items"]
        pending = [m for m in matches if m["qualified_at"] is None]
        if matches and not pending and time.monotonic() - last_change > 10:
            break
        if pending or not matches:
            last_change = time.monotonic()
        time.sleep(3)
    if not matches:
        _say("No matches. Widen the search (more CPV prefixes) or ingest a longer window with --since.")
        return 1
    _say(f"{len(matches)} matches, {sum(1 for m in matches if m['qualified_at'])} qualified")
    for m in matches[:5]:
        _say(f"  - {m['notice_title'][:90]} (deadline {m['notice_deadline_at']})")

    _step(6, "Agent proposals (nothing has run: a human must approve each one)")
    props = call("GET", f"{base}/agent-proposals?status=pending&limit=200", token).json()["items"]
    by_notice: dict[str, list[dict[str, Any]]] = {}
    for p in props:
        by_notice.setdefault(p["notice_id"], []).append(p)
    soon = (datetime.now(UTC) + timedelta(days=15)).isoformat()
    deadlines = {m["notice_id"]: m["notice_deadline_at"] or "" for m in matches}

    def rank(ps: list[dict[str, Any]]) -> tuple[int, int, int]:
        has_reminders = any(p["action_type"] == "add_deadline_reminders" for p in ps)
        far = (deadlines.get(ps[0]["notice_id"]) or "") >= soon  # reminders need time before the deadline
        return (int(has_reminders and far), ps[0]["fit_score"] or 0, len(ps))

    best = max(by_notice.values(), key=rank, default=[])
    if not best:
        _say("The agent produced no proposals.")
        return 1
    _say(f"best fit {best[0]['fit_score']}/100; proposals:")
    for p in best:
        _say(f"  - {p['action_type']}: {json.dumps(p['payload'])}  ({p['rationale']})")
    opps = call("GET", f"{base}/opportunities", token).json()["items"]
    _say(f"opportunities before approval: {len(opps)}")

    _step(7, "Approve through the API (as the bid manager)")
    for p in best:
        if p["action_type"] in ("create_opportunity", "add_deadline_reminders"):
            r = call(
                "POST",
                f"{base}/agent-proposals/{p['id']}/approve",
                token,
                f"demo-approve-{p['id']}",
                json={"comment": "approved in demo"},
            )
            _say(f"  approve {p['action_type']}: HTTP {r.status_code}")
    end = time.monotonic() + 60
    executed: list[dict[str, Any]] = []
    while time.monotonic() < end:
        executed = [
            p
            for p in call("GET", f"{base}/agent-proposals?status=executed", token).json()["items"]
            if p["notice_id"] == best[0]["notice_id"]
        ]
        approved_n = sum(1 for p in best if p["action_type"] in ("create_opportunity", "add_deadline_reminders"))
        if len(executed) >= approved_n:
            break
        time.sleep(2)
    for p in executed:
        _say(f"  executed {p['action_type']}: {json.dumps(p['result'])}")

    _step(8, "Resulting opportunity, reminders and audit trail")
    opps = call("GET", f"{base}/opportunities", token).json()["items"]
    if not opps:
        _say("No opportunity was created.")
        return 1
    opp = call("GET", f"{base}/opportunities/{opps[0]['id']}", token).json()
    _say(f"opportunity: {opp['notice_title'][:80]} status={opp['status']} workflow={opp['workflow_id']}")
    for d in opp["deadlines"]:
        _say(f"  {d['kind']:<10} due {d['due_at']}  [{d['source']}] {d['note'] or ''}")
    audit = call("GET", f"{base}/audit-log?limit=12", token).json()["items"]
    _say("audit log (newest first):")
    for a in audit:
        _say(
            f"  {a['occurred_at'][:19]} {a['actor_type']:<5} {a['actor_id'][:24]:<24} {a['action']}  trace={a['trace_id'] or '-'}"
        )
    n_rem = sum(1 for d in opp["deadlines"] if d["kind"] == "reminder")
    _say(f"\nDone: {len(matches)} matches, {len(executed)} approved actions executed, {n_rem} reminders scheduled.")
    _say(f"Finished at {datetime.now(UTC):%H:%M:%S}Z. Open Grafana at http://localhost:3000 to see the traces.")
    return 0
