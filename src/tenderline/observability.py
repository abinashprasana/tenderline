"""OpenTelemetry traces, metrics and logs, plus structured JSON logging.

Export is controlled only by environment variables (see .env.example / SETUP.md):
  OTEL_EXPORTER_OTLP_ENDPOINT   base URL of an OTLP/HTTP receiver (the local collector, or Grafana Cloud's gateway)
  OTEL_EXPORTER_OTLP_HEADERS    e.g. "Authorization=Basic <base64 instance:token>" for Grafana Cloud
With no endpoint set, traces still exist in-process (so audit rows carry trace ids) but nothing is exported.
"""

from __future__ import annotations

import logging
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote

from opentelemetry import metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import Span, SpanKind, Status, StatusCode
from pythonjsonlogger.json import JsonFormatter

from tenderline import __version__
from tenderline.config import get_settings
from tenderline.reqctx import get_request_id

_configured = False
_tracer = trace.get_tracer("tenderline")
_meter = metrics.get_meter("tenderline")


def _create_instruments() -> dict[str, Any]:
    return {
        "http": _meter.create_histogram(
            "tenderline.http.request.duration",
            unit="s",
            description="API latency",
            explicit_bucket_boundaries_advisory=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        ),
        "llm_calls": _meter.create_counter("tenderline.llm.calls", description="LLM calls by provider and status"),
        "llm_cost": _meter.create_counter("tenderline.llm.cost_usd", description="LLM spend (USD) per organisation"),
        "llm_latency": _meter.create_histogram(
            "tenderline.llm.latency",
            unit="ms",
            description="LLM latency",
            explicit_bucket_boundaries_advisory=[10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
        ),
        "ingested": _meter.create_counter("tenderline.notices.ingested", description="New notices stored"),
        "wf_failures": _meter.create_counter("tenderline.workflow.failures", description="Failed workflows"),
    }


_instruments = _create_instruments()


def current_trace_id() -> str | None:
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx.is_valid else None


def record_exception(exc: BaseException) -> None:
    span = trace.get_current_span()
    if span.is_recording():
        span.record_exception(exc)
        span.set_status(Status(StatusCode.ERROR, str(exc)[:200]))


def record_http(method: str, route: str, status: int, seconds: float) -> None:
    _instruments["http"].record(seconds, {"http.method": method, "http.route": route, "http.status_code": status})


def record_llm_call(org_id: str, provider: str, model: str, latency_ms: int, cost_usd: float, status: str) -> None:
    attrs = {"org_id": org_id, "provider": provider, "model": model, "status": status}
    _instruments["llm_calls"].add(1, attrs)
    if status == "ok":
        _instruments["llm_cost"].add(cost_usd, attrs)
        _instruments["llm_latency"].record(latency_ms, attrs)


def record_ingested(count: int, source: str) -> None:
    if count:
        _instruments["ingested"].add(count, {"source": source})


def record_workflow_failure(name: str) -> None:
    _instruments["wf_failures"].add(1, {"workflow": name})


# ------------------------------------------------------------------------------------------ tracing helpers
def tracer() -> trace.Tracer:
    return _tracer


def current_traceparent() -> str | None:
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    return carrier.get("traceparent")


@contextmanager
def continue_trace(
    traceparent: str | None, name: str, attributes: dict[str, Any] | None = None, *, link_only: bool = False
) -> Iterator[Span]:
    """Run a block as work caused by a trace that started elsewhere, such as the request that queued it.

    By default the span joins that trace as a child, which suits one request causing one job. With
    `link_only` the span starts its own trace and carries a link back instead. That is what the OpenTelemetry
    messaging conventions recommend for fan-out: one request that queues hundreds of jobs would otherwise
    produce a single trace with thousands of spans.
    """
    remote = propagate.extract({"traceparent": traceparent}) if traceparent else None
    links = []
    if link_only and remote is not None:
        remote_span = trace.get_current_span(remote).get_span_context()
        if remote_span.is_valid:
            links.append(trace.Link(remote_span))
    with _tracer.start_as_current_span(
        name,
        context=Context() if link_only else remote,
        kind=SpanKind.CONSUMER,
        attributes=attributes,
        links=links,
    ) as span:
        yield span


# ------------------------------------------------------------------------------------------ gauges
def _ingest_lag(_: CallbackOptions) -> Iterator[Observation]:
    try:
        from sqlalchemy import func, select

        from tenderline.db import public_session
        from tenderline.models import IngestionRun

        with public_session() as db:
            last = db.scalar(
                select(func.max(IngestionRun.finished_at)).where(
                    IngestionRun.status == "ok", IngestionRun.source == "ted"
                )
            )
        yield Observation(float((datetime.now(UTC) - last).total_seconds()) if last else 10**9)
    except Exception:  # noqa: BLE001 - a gauge callback must never raise
        return


def _queue_depth(_: CallbackOptions) -> Iterator[Observation]:
    try:
        import psycopg

        url = get_settings().dbos_system_database_url.replace("postgresql+psycopg://", "postgresql://")
        with psycopg.connect(url, connect_timeout=3) as c:
            rows = c.execute(
                "SELECT queue_name, status, count(*) FROM dbos.workflow_status "
                "WHERE status IN ('ENQUEUED','PENDING') GROUP BY 1, 2"
            ).fetchall()
        seen = {(q or "-", s) for q, s, _n in rows}
        for q, s, n in rows:
            yield Observation(n, {"queue": q or "-", "status": s})
        for q in ("enrich", "qualify", "ingest"):
            if (q, "ENQUEUED") not in seen:
                yield Observation(0, {"queue": q, "status": "ENQUEUED"})
    except Exception:  # noqa: BLE001
        return


def _register_gauges() -> None:
    _meter.create_observable_gauge(
        "tenderline.ingest.lag",
        callbacks=[_ingest_lag],
        unit="s",
        description="Seconds since the last successful ingestion",
    )
    _meter.create_observable_gauge(
        "tenderline.queue.depth", callbacks=[_queue_depth], description="Workflows enqueued / running per queue"
    )


# ------------------------------------------------------------------------------------------ setup
def _headers(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in filter(None, (p.strip() for p in raw.split(","))):
        k, _, v = part.partition("=")
        out[k.strip()] = unquote(v.strip())
    return out


class _ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        ctx = trace.get_current_span().get_span_context()
        record.trace_id = format(ctx.trace_id, "032x") if ctx.is_valid else None
        record.span_id = format(ctx.span_id, "016x") if ctx.is_valid else None
        record.request_id = get_request_id()
        return True


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter(
            "%(asctime)s %(levelname)s %(name)s %(message)s %(trace_id)s %(span_id)s %(request_id)s",
            rename_fields={"asctime": "timestamp", "levelname": "level", "name": "logger"},
        )
    )
    handler.addFilter(_ContextFilter())
    handler._tenderline = True  # type: ignore[attr-defined]
    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if not getattr(h, "_tenderline", False)]
    root.addHandler(handler)
    root.setLevel(level.upper())


class _LlmSpanFilter:
    """Forward only LLM spans (`llm.*`) to an exporter, e.g. Langfuse."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def export(self, spans: Any) -> Any:
        return self._inner.export([s for s in spans if s.name.startswith("llm.")])

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return bool(self._inner.force_flush(timeout_millis))


def setup_telemetry(service_name: str | None = None, *, span_exporter: Any = None) -> None:
    """Idempotent. Installs a tracer provider (so trace ids exist) and exports only if configured."""
    global _configured, _tracer, _meter, _instruments
    if _configured:
        return
    s = get_settings()
    configure_logging(s.log_level)
    if not s.otel_enabled:
        return
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor

    resource = Resource.create(
        {
            "service.name": service_name or s.service_name,
            "service.version": __version__,
            "deployment.environment": s.env,
        }
    )
    provider = TracerProvider(resource=resource)
    endpoint = s.otel_exporter_otlp_endpoint.rstrip("/")
    headers = _headers(s.otel_exporter_otlp_headers)
    if span_exporter is not None:
        provider.add_span_processor(SimpleSpanProcessor(span_exporter))
    elif endpoint:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces", headers=headers))
        )
    if s.langfuse_public_key and s.langfuse_secret_key and span_exporter is None:
        # Optional: LLM spans also go to Langfuse over OTLP (basic auth with the project keys). Off without keys.
        import base64

        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter as LfExporter

        token = base64.b64encode(f"{s.langfuse_public_key}:{s.langfuse_secret_key}".encode()).decode()
        lf = LfExporter(
            endpoint=f"{s.langfuse_host.rstrip('/')}/api/public/otel/v1/traces",
            headers={"Authorization": f"Basic {token}"},
        )
        provider.add_span_processor(BatchSpanProcessor(_LlmSpanFilter(lf)))  # type: ignore[arg-type]
    trace.set_tracer_provider(provider)
    _tracer = trace.get_tracer("tenderline")

    if endpoint:
        from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

        reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=f"{endpoint}/v1/metrics", headers=headers), export_interval_millis=10_000
        )
        metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[reader]))
        logger_provider = LoggerProvider(resource=resource)
        logger_provider.add_log_record_processor(
            BatchLogRecordProcessor(OTLPLogExporter(endpoint=f"{endpoint}/v1/logs", headers=headers))
        )
        logging.getLogger().addHandler(LoggingHandler(level=logging.INFO, logger_provider=logger_provider))
        _meter = metrics.get_meter("tenderline")
        _instruments = _create_instruments()  # instruments made before the provider existed were no-op proxies
        _register_gauges()
    _configured = True


def instrument_app(app: Any) -> None:
    """Auto-instrument FastAPI, httpx and SQLAlchemy: one trace per request, DB and outbound calls included."""
    if not get_settings().otel_enabled:
        return
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

    from tenderline.db import get_engine

    FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz")
    HTTPXClientInstrumentor().instrument()
    SQLAlchemyInstrumentor().instrument(engine=get_engine())


def timer() -> float:
    return time.perf_counter()
