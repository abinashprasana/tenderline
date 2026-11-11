"""Generate the provisioned Grafana dashboard JSON: `python observability/build_dashboard.py`."""

from __future__ import annotations

import json
from pathlib import Path

PROM = {"type": "prometheus", "uid": "prometheus"}
TEMPO = {"type": "tempo", "uid": "tempo"}
LOKI = {"type": "loki", "uid": "loki"}
_id = 0


def _next() -> int:
    global _id
    _id += 1
    return _id


def panel(
    title: str,
    exprs: list[tuple[str, str]],
    x: int,
    y: int,
    w: int = 8,
    h: int = 8,
    unit: str = "short",
    kind: str = "timeseries",
    ds: dict | None = None,
    description: str = "",
) -> dict:
    return {
        "id": _next(),
        "title": title,
        "type": kind,
        "description": description,
        "datasource": ds or PROM,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "fieldConfig": {"defaults": {"unit": unit}, "overrides": []},
        "options": {"legend": {"displayMode": "list", "placement": "bottom"}} if kind == "timeseries" else {},
        "targets": [
            {"refId": chr(65 + i), "expr": e, "legendFormat": legend, "datasource": ds or PROM}
            for i, (e, legend) in enumerate(exprs)
        ],
    }


def row(title: str, y: int) -> dict:
    return {
        "id": _next(),
        "type": "row",
        "title": title,
        "gridPos": {"x": 0, "y": y, "w": 24, "h": 1},
        "collapsed": False,
    }


D = "tenderline_http_request_duration_seconds"
panels = [
    row("API", 0),
    panel(
        "API p95 latency", [(f"histogram_quantile(0.95, sum by (le) (rate({D}_bucket[5m])))", "p95")], 0, 1, unit="s"
    ),
    panel(
        "Requests per second by route",
        [(f"sum by (http_route) (rate({D}_count[5m]))", "{{http_route}}")],
        8,
        1,
        unit="reqps",
    ),
    panel(
        "Error rate (5xx)",
        [
            (
                f'(sum(rate({D}_count{{http_status_code=~"5.."}}[5m])) / sum(rate({D}_count[5m]))) or vector(0)',
                "5xx ratio",
            )
        ],
        16,
        1,
        unit="percentunit",
    ),
    row("Ingestion", 9),
    panel(
        "Notices ingested (new, per hour)",
        [("sum by (source) (increase(tenderline_notices_ingested_total[1h]))", "{{source}}")],
        0,
        10,
    ),
    panel(
        "Ingest lag (hours since last successful run)",
        [("tenderline_ingest_lag_seconds / 3600", "hours")],
        8,
        10,
        unit="h",
        description="Alert fires above 36h.",
    ),
    panel(
        "Workflow failures",
        [("sum by (workflow) (increase(tenderline_workflow_failures_total[1h])) or vector(0)", "{{workflow}}")],
        16,
        10,
    ),
    row("Queues", 18),
    panel("Queue depth", [("sum by (queue, status) (tenderline_queue_depth)", "{{queue}} {{status}}")], 0, 19, w=12),
    panel(
        "Qualified per hour (LLM calls ok)",
        [('sum(increase(tenderline_llm_calls_total{status="ok"}[1h]))', "ok")],
        12,
        19,
        w=12,
    ),
    row("LLM", 27),
    panel(
        "LLM cost per organisation (USD, 24h)",
        [("sum by (org_id) (increase(tenderline_llm_cost_usd_total[24h]))", "{{org_id}}")],
        0,
        28,
        unit="currencyUSD",
    ),
    panel(
        "LLM latency p95 by provider",
        [
            (
                "histogram_quantile(0.95, sum by (le, provider) (rate(tenderline_llm_latency_milliseconds_bucket[15m])))",
                "{{provider}}",
            )
        ],
        8,
        28,
        unit="ms",
    ),
    panel(
        "LLM calls by status",
        [("sum by (provider, status) (increase(tenderline_llm_calls_total[1h]))", "{{provider}} {{status}}")],
        16,
        28,
    ),
    row("Traces and logs", 36),
    {
        **panel("Recent traces (API -> queue -> LLM -> DB)", [], 0, 37, w=24, h=9, kind="table", ds=TEMPO),
        "targets": [
            {
                "refId": "A",
                "datasource": TEMPO,
                "queryType": "traceql",
                "query": '{ resource.service.name = "tenderline-api" && (name =~ "POST.*" || name =~ "queue.*" || name = "llm.complete") }',
                "limit": 20,
                "tableType": "traces",
            }
        ],
    },
    {
        **panel("Logs (JSON, with trace ids)", [], 0, 46, w=24, h=9, kind="logs", ds=LOKI),
        "targets": [
            {"refId": "A", "datasource": LOKI, "expr": '{service_name="tenderline-api"}', "queryType": "range"}
        ],
    },
]

dashboard = {
    "uid": "tenderline-overview",
    "title": "Tenderline overview",
    "tags": ["tenderline"],
    "timezone": "browser",
    "schemaVersion": 39,
    "version": 1,
    "refresh": "15s",
    "time": {"from": "now-1h", "to": "now"},
    "panels": panels,
    "templating": {"list": []},
    "annotations": {"list": []},
}

if __name__ == "__main__":
    out = Path(__file__).parent / "grafana" / "dashboards" / "tenderline.json"
    out.write_text(json.dumps(dashboard, indent=1), encoding="utf-8")
    print(f"wrote {out}")  # noqa: T201
