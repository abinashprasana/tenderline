# Schema changes: expand and contract

All schema changes go through Alembic (`src/tenderline/migrations/versions`). `alembic check` in CI fails if the models and the migrations drift.

## Worked example: adding `organisations.timezone` (migration `0003`)

Goal: let each organisation have a timezone, with zero downtime and a safe rollback of the application.

1. **Expand (this migration, deployed first).** Add the column as `NULL`-able with a server default:
   ```python
   op.add_column("organisations", sa.Column("timezone", sa.String(64), nullable=True, server_default="Europe/Dublin"))
   ```
   The previous application version neither reads nor writes the column, so it keeps working against the new schema. Rolling the app back needs no schema change.
2. **Migrate code.** Deploy the application that reads and writes `timezone` (the model and `PATCH /v1/organisations/{id}`). Backfill is unnecessary because the default covers existing rows; for a column without a safe default, backfill in batches here.
3. **Contract (a later release, only if wanted).** After every running version uses the column, tighten it (`SET NOT NULL`) or drop old columns in a separate migration. Never combine expand and contract in one release.

Rules of thumb: add columns as nullable or with a default; do not rename or drop in the same release that stops using the old name (add new, dual-write, switch reads, then drop); create indexes with `CREATE INDEX CONCURRENTLY` on large tables; keep migrations idempotent and reversible where possible.

Migration `0004` follows the same rule: it only adds database defaults, which cannot break existing writers.
