# ADR 0002: Postgres on the VM vs a managed free tier

**Status:** accepted

## Context
Production runs on one Oracle Cloud Always Free Ampere A1 VM (2 OCPU, 12 GB). We need Postgres 16 with row-level security, a non-superuser role, triggers, and a second database for DBOS.

## Options
- **Managed free tiers**: no ops burden, but free tiers typically cap storage, connections and idle time, may not allow creating roles, extra databases or `NOBYPASSRLS` roles freely, and add network latency and a second vendor for the single most important component.
- **Postgres in Docker on the VM**: full control of roles, extensions and tuning; zero latency; no extra account.

## Decision
Run `postgres:16` in the production compose stack on the VM, on a named volume, not published to the internet (only Caddy exposes 80/443; the OCI security list allows only SSH from the admin CIDR, 80 and 443).

## Consequences
- We own backups: `scripts/backup.sh` dumps both databases nightly (verifies each archive with `pg_restore --list`), keeps 14 days locally, and uploads to an object-storage bucket when its S3-compatible credentials are set. Restore is `scripts/restore.sh` and has been exercised against a scratch database.
- Single point of failure and no HA; acceptable for the target (5-50 person firms, a daily batch pipeline). RPO is up to 24 hours unless backups are made more frequent.
- If the load or the SLA grows, move to a managed Postgres and change only `DATABASE_URL`, `APP_DATABASE_URL` and `DBOS_SYSTEM_DATABASE_URL`.
