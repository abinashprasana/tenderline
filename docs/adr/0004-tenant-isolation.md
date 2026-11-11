# ADR 0004: Tenant isolation approach

**Status:** accepted

## Context
Multiple small companies share one database. A bug in any query must not leak or modify another tenant's data.

## Decision
Shared schema with **Postgres row-level security** as the enforcement layer, not application filters alone.
- Every tenant-owned table has `organisation_id` and a policy `organisation_id = NULLIF(current_setting('app.org_id', true), '')::uuid` for both reads and writes (`organisations` uses `id`). No tenant context means no rows.
- The app connects as `tenderline_app`: not a superuser, `NOBYPASSRLS`, not the table owner. Migrations run as the owner.
- Each request opens a transaction and runs `set_config('app.org_id', ..., true)` (transaction-local), so a pooled connection cannot carry one tenant's context into the next request (tested across repeated pooled checkouts).
- Membership is resolved before the tenant transaction through `SECURITY DEFINER` functions that return only ids and roles (`app_membership_role`, `app_user_memberships`, `app_list_org_ids`, `app_orgs_for_notice`, `app_stale_approved_proposals`). They are the only deliberate way around RLS, and are revoked from `PUBLIC`.
- Addressing another tenant's organisation returns **404**, not 403, so organisation ids cannot be enumerated.
- Shared data (notices, buyers, CPV codes, ingestion runs) is public procurement data and has no RLS.
- `audit_log` and `notice_versions` are append-only: triggers reject UPDATE, DELETE and TRUNCATE (even for the owner) and the app role has no such privileges.
- The table owner bypasses RLS (no `FORCE`), which keeps definer functions, tests and seeding simple; the owner credential is used only by migrations.

## Consequences
Isolation holds even if a handler forgets a filter. Tests prove tenant A cannot read or write tenant B's rows at the SQL level and through the API (matches, proposals, approvals, organisations). The rate limiter is per organisation and in-process, which is correct for the single-process deployment; a multi-process deployment would need a shared limiter.
