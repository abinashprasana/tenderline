"""OpenTelemetry helpers. Full provider setup is added in the observability step."""

from __future__ import annotations

from opentelemetry import trace


def current_trace_id() -> str | None:
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx.is_valid else None


def record_exception(exc: BaseException) -> None:
    span = trace.get_current_span()
    if span.is_recording():
        span.record_exception(exc)


# ---- metrics (instruments are no-ops until a MeterProvider is configured in the observability step)
from opentelemetry import metrics  # noqa: E402

_meter = metrics.get_meter("tenderline")
_llm_calls = _meter.create_counter("tenderline.llm.calls", description="LLM calls by provider and status")
_llm_cost = _meter.create_counter("tenderline.llm.cost_usd", unit="USD", description="LLM spend per organisation")
_llm_latency = _meter.create_histogram("tenderline.llm.latency_ms", unit="ms", description="LLM latency")


def record_llm_call(org_id: str, provider: str, model: str, latency_ms: int, cost_usd: float, status: str) -> None:
    attrs = {"org_id": org_id, "provider": provider, "model": model, "status": status}
    _llm_calls.add(1, attrs)
    if status == "ok":
        _llm_cost.add(cost_usd, attrs)
        _llm_latency.record(latency_ms, attrs)


_ingested = _meter.create_counter("tenderline.notices.ingested", description="New notices stored")
_wf_failures = _meter.create_counter("tenderline.workflow.failures", description="Failed workflows")


def record_ingested(count: int, source: str) -> None:
    if count:
        _ingested.add(count, {"source": source})


def record_workflow_failure(name: str) -> None:
    _wf_failures.add(1, {"workflow": name})
