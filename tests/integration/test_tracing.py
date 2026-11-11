import uuid

import pytest
from dbos import DBOS
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from sqlalchemy import text

from tenderline import observability
from tenderline.config import get_settings
from tenderline.db import owner_session, reset_engines
from tenderline.security import create_token
from tests.helpers import quiesce_workflows, reset_notice_tables, seed_match, set_profile, wait_for


def test_one_trace_spans_api_queue_llm_call_and_database(runtime, make_org, monkeypatch):
    reset_notice_tables()
    org = make_org("Acme Hosting")
    set_profile(org["org_id"], capabilities=["cloud hosting"], regions=["IRL"])
    _, match_id, _ = seed_match(org["org_id"])

    monkeypatch.setenv("OTEL_ENABLED", "true")
    get_settings.cache_clear()
    reset_engines()
    exporter = InMemorySpanExporter()
    observability.setup_telemetry(span_exporter=exporter)
    try:
        from tenderline.api.app import create_app

        with TestClient(create_app()) as client:
            r = client.post(
                f"/v1/organisations/{org['org_id']}/matches/{match_id}/qualify",
                headers={
                    "Authorization": f"Bearer {create_token(org['user_id'])}",
                    "Idempotency-Key": f"trace-{uuid.uuid4().hex}",
                },
            )
            assert r.status_code == 202, r.text
            wid = r.json()["workflow_id"]
            out = DBOS.retrieve_workflow(wid).get_result()
        assert out["status"] == "qualified"
        wait_for(lambda: any(s.name == "llm.complete" for s in exporter.get_finished_spans()), message="llm span")
        spans = exporter.get_finished_spans()
        server = next(
            s
            for s in spans
            if s.name.startswith("POST") and "qualify" in (s.attributes or {}).get("http.target", s.name)
        )
        trace_id = server.context.trace_id
        same = [s for s in spans if s.context.trace_id == trace_id]
        names = {s.name for s in same}
        assert "queue.qualify_match" in names, names  # the queue worker continued the request's trace
        assert "llm.complete" in names, names  # ... and so did the LLM call
        assert any(
            n.split(" ")[0] in ("SELECT", "INSERT", "UPDATE", "connect") or "tenderline" in n for n in names
        )  # DB spans
        llm = next(s for s in same if s.name == "llm.complete")
        assert llm.attributes["llm.provider"] == "fake"
        hexid = format(trace_id, "032x")
        with owner_session() as s:
            call_trace = s.execute(
                text("SELECT trace_id FROM llm_calls WHERE organisation_id=:o"), {"o": org["org_id"]}
            ).scalar()
            audit_traces = {
                r[0]
                for r in s.execute(
                    text(
                        "SELECT trace_id FROM audit_log WHERE action IN ('proposal.created','match.qualified') AND organisation_id=:o"
                    ),
                    {"o": org["org_id"]},
                )
            }
        assert call_trace == hexid and audit_traces == {hexid}  # propagated into llm_calls and audit_log
    finally:
        quiesce_workflows()
        monkeypatch.setenv("OTEL_ENABLED", "false")
        get_settings.cache_clear()
        reset_engines()


@pytest.mark.parametrize(
    "raw,expected", [("Authorization=Basic%20abc,X-Scope=1", {"Authorization": "Basic abc", "X-Scope": "1"}), ("", {})]
)
def test_otlp_headers_come_from_environment_format(raw, expected):
    assert observability._headers(raw) == expected
