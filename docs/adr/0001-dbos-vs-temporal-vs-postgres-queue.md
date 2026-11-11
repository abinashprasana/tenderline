# ADR 0001: DBOS Transact vs Temporal vs a plain Postgres queue

**Status:** accepted

## Context
We need durable workflows: a daily resumable ingestion, queues with concurrency limits, and a per-opportunity workflow that sleeps for days or weeks, waits for signals, and survives restarts. Target: one small VM on Always Free, one Postgres, minimal moving parts.

## Options
- **Temporal**: the most capable engine, but needs its own server cluster (plus a database and usually Elasticsearch for visibility). Too heavy for a 2 OCPU / 12 GB VM that also runs the app, Postgres and monitoring.
- **Plain Postgres queue** (e.g. `SELECT ... FOR UPDATE SKIP LOCKED` plus cron): minimal dependencies, but we would hand-write retries, durable timers, signals/`recv`, step checkpointing, schedules and crash recovery. That is exactly where subtle bugs live.
- **DBOS Transact (Python)**: a library, not a server. Workflow and step state, queues (worker/global concurrency), cron schedules, durable sleep and send/recv are stored in Postgres.

## Decision
DBOS, with its state in a separate database (`tenderline_dbos`) on the same Postgres instance.

## Consequences
- One fewer service to run and back up; recovery after restart is automatic (proved by the kill-and-restart tests).
- Steps are at-least-once. Exactly-once effects are built on top: the approved-action tool commits its writes and flips the proposal to `executed` in one transaction, and the workflow id equals the proposal id.
- Workflow code must be deterministic; side effects live in steps.
- Findings while implementing (verified against the docs and package): DBOS's sync API cannot run inside a live event loop, so the runtime starts from a worker thread in the FastAPI lifespan; `DBOS.send` belongs in workflow bodies, not steps; `DBOS.recv(timeout)` is used as the durable timer, with a configurable cap per wake-up so shutdown stays prompt. Two processes sharing an executor id would recover each other's workflows, so CLI commands enqueue through `DBOSClient` instead of launching a second runtime.
- Lock-in is moderate (decorators); the domain logic is plain functions.

## Measured later: what a waiting workflow costs
Each open opportunity has one workflow parked in `DBOS.recv`. We measured 300 waiting workflows in DBOS 3.5.0 three ways: sync workflows, coroutine workflows started from sync code or a queue, and coroutine workflows with DBOS launched inside the event loop. All three used roughly one thread per waiting workflow (307 to 501 threads). Releasing the thread needs `suspend=True`, which the docs say requires DBOS Transact Enterprise. So converting to async buys nothing here, and the workflow stays sync.

The executor pool is unbounded (`max_executor_threads` defaults to no limit), so parked workflows cannot starve queue work; the cost is memory. That is fine for hundreds of open opportunities on the 12 GB VM. For thousands, either license suspend mode or replace the parked workflow with delayed queue entries (`SetEnqueueOptions(delay_seconds=...)`), which hold no thread.

## Deploys and application versions
DBOS resumes only the workflows started by the same `application_version`. Without care, every deploy would strand the previous release's opportunity workflows and reminders would stop without any error. Two things prevent that: `APP_VERSION` identifies the release, and the `opportunity-workflow-reconciler` schedule (every 10 minutes) starts a fresh workflow for any open opportunity that has no live workflow on the running version. Firing a reminder is exactly-once at the row level, so an old and a new workflow overlapping is harmless.

## Retention
Finished workflow records are deleted after `WORKFLOW_RETENTION_DAYS` (default 30) by the `daily-cleanup` schedule, together with idempotency keys older than `IDEMPOTENCY_KEY_RETENTION_DAYS`. One load test had left 43,000 workflow rows. The audit log and notice versions are never deleted.
