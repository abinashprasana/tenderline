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
