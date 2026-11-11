"""`tenderline` command line: migrations, serving, ingestion, the eTenders loader, evaluation, seeding, demo."""

from __future__ import annotations

import json
import sys
import time
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Annotated, Any

import typer

app = typer.Typer(no_args_is_help=True, help="Tenderline operations")


@app.command()
def migrate() -> None:
    """Apply database migrations (as the table owner)."""
    from alembic import command
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parent / "migrations"))
    command.upgrade(cfg, "head")
    typer.echo("migrations applied")


@app.command()
def serve(host: str = "0.0.0.0", port: int = 8000, skip_migrate: bool = False) -> None:  # noqa: S104
    """Run migrations, then the API with the DBOS workflow runtime."""
    import uvicorn

    if not skip_migrate:
        migrate()
    uvicorn.run("tenderline.api.app:app", host=host, port=port, log_config=None)


@app.command()
def openapi(out: Path = Path("docs/openapi.json")) -> None:
    """Export the OpenAPI spec."""
    import os

    os.environ.setdefault("WORKFLOWS_ENABLED", "false")
    from tenderline.api.app import create_app

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(create_app().openapi(), indent=2), encoding="utf-8")
    typer.echo(f"wrote {out}")


@app.command()
def ingest(
    since: Annotated[str | None, typer.Option(help="YYYY-MM-DD; default: resume / last-success window")] = None,
    wait: bool = True,
    timeout: int = 1800,
) -> None:
    """Start a TED ingestion in the running app (via the DBOS queue) and optionally wait for it."""
    from dbos import DBOSClient

    from tenderline.config import get_settings

    client = DBOSClient(system_database_url=get_settings().dbos_system_database_url, application_name="tenderline")
    handle: Any = client.enqueue({"queue_name": "ingest", "workflow_name": "ingest_ted_workflow"}, since)
    typer.echo(f"enqueued ingestion workflow {handle.workflow_id}")
    if not wait:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = handle.get_status().status
        if status in ("SUCCESS", "ERROR", "CANCELLED"):
            typer.echo(f"status: {status}")
            if status == "SUCCESS":
                typer.echo(json.dumps(handle.get_result(), indent=1, default=str))
            raise typer.Exit(0 if status == "SUCCESS" else 1)
        time.sleep(3)
    typer.echo("timed out waiting; the workflow keeps running", err=True)
    raise typer.Exit(2)


@app.command("etenders-load")
def etenders_load(
    path: Path,
    since: Annotated[str | None, typer.Option(help="only rows published on/after YYYY-MM-DD")] = None,
    limit: Annotated[int | None, typer.Option(help="stop after N rows")] = None,
    open_only: Annotated[bool, typer.Option(help="skip rows whose deadline has passed")] = False,
    match: Annotated[bool, typer.Option(help="queue matching for newly loaded open notices")] = True,
) -> None:
    """Import the eTenders open-data CSV from a local file (columns are detected from its header)."""
    from tenderline.etenders import CsvFormatError, load_csv

    if not path.exists():
        raise typer.BadParameter(f"{path} does not exist")
    try:
        stats = load_csv(
            path,
            since=date.fromisoformat(since) if since else None,
            limit=limit,
            only_open_after=datetime.now(UTC) if open_only else None,
        )
    except CsvFormatError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc
    typer.echo(
        f"rows={stats.rows} new={stats.new} updated={stats.updated} unchanged={stats.unchanged} skipped={stats.skipped} "
        f"encoding={stats.encoding}"
    )
    typer.echo(
        "Data: 'Contract Notices Published on eTenders' (data.gov.ie, CC BY 4.0, Office of Government Procurement)"
    )


@app.command("eval-agent")
def eval_agent(
    file: Path,
    providers: Annotated[str | None, typer.Option(help="comma list, default LLM_PROVIDER_CHAIN")] = None,
    as_json: bool = False,
) -> None:
    """Score the agent's fit_score against a labelled JSONL file."""
    from tenderline.agent.evaluate import evaluate
    from tenderline.agent.providers import build_providers
    from tenderline.config import Settings, get_settings

    s = get_settings()
    if providers:
        s = Settings(**{**s.model_dump(), "llm_provider_chain": providers})
    result = evaluate(file, build_providers(s))
    if as_json:
        typer.echo(json.dumps(result.__dict__, indent=1, default=str))
        return
    if result.synthetic:
        typer.echo("!! These labels are SYNTHETIC. Scores below only exercise the pipeline, not real-world quality.\n")
    typer.echo(f"records={result.n} scored={result.scored} invalid={result.invalid} errors={result.errors}")

    def f(v: float | None) -> str:
        return "n/a" if v is None else f"{v:.3f}"

    typer.echo(f"MAE={f(result.mae)} RMSE={f(result.rmse)} Pearson={f(result.pearson)} Spearman={f(result.spearman)}")
    typer.echo(
        f"pursue/skip @60: accuracy={f(result.accuracy)} precision={f(result.precision)} recall={f(result.recall)}"
    )
    for row in result.rows:
        typer.echo(f"  {row['id']:<8} label={row['label']:>5} predicted={row['predicted']!s:>5} {row['status']}")


@app.command("seed")
def seed_cmd(
    orgs: int = 3,
    notices: int = 600,
    proposals: int = 120,
    out: Path = Path("k6/seed.json"),
    base_url: str = "http://localhost:8000",
) -> None:
    """Seed realistic synthetic data and write the k6 fixture file."""
    from tenderline.seed import seed

    res = seed(orgs, notices, proposals, out, base_url)
    for o in res["orgs"]:
        typer.echo(
            f"org {o['org_id']}: {len(o['match_ids'])} matches, {len(o['pending_proposal_ids'])} pending proposals"
        )
    typer.echo(f"wrote {out}")


@app.command()
def demo(
    base_url: str = "http://localhost:8000",
    since: Annotated[str | None, typer.Option(help="ingest window start YYYY-MM-DD (default: 14 days ago)")] = None,
    cpv: str = "72,48,79,71",
    skip_ingest: bool = False,
) -> None:
    """End-to-end walkthrough against a running stack: ingest real TED notices -> match -> proposal -> approve."""
    from tenderline.demo import run_demo

    sys.exit(run_demo(base_url, since, [c.strip() for c in cpv.split(",") if c.strip()], skip_ingest))


if __name__ == "__main__":
    app()
