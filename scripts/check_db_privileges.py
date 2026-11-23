#!/usr/bin/env python
"""Can this Postgres database host Tenderline? Run it before deploying to a managed database.

    uv run python scripts/check_db_privileges.py "postgresql://user:password@host/dbname"
    DATABASE_URL=... uv run python scripts/check_db_privileges.py

Use the owner role's URL (the one that will run the migrations). The password is never printed.

What it checks, and why:

* CREATE ROLE ... NOBYPASSRLS: migration 0002 creates the `tenderline_app` role this way. (It ALTERs the role only
  if it already exists, which Postgres 16 refuses to a non-superuser, so that one is reported as a warning.)
* RLS enforced for a new app role: it creates a throwaway role and table, logs in as that role and checks that
  row-level security really hides other organisations' rows. Tenant isolation depends on this.
* CREATE DATABASE / CREATE SCHEMA: DBOS needs somewhere for its tables, either its own database or its own
  schema in this one (`DBOS_SYSTEM_DATABASE_URL` may point at the application database).
* LISTEN/NOTIFY: DBOS listens on a dedicated connection by default. A transaction pooler cannot deliver this.

Everything it creates is dropped again. Exit status 0 when every required check passes, 1 otherwise.
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys
from collections.abc import Callable
from dataclasses import dataclass

import psycopg
from psycopg import sql
from sqlalchemy.engine import URL, make_url

PASS, FAIL, WARN, INFO = "PASS", "FAIL", "WARN", "INFO"


@dataclass
class Result:
    status: str
    name: str
    detail: str = ""
    required: bool = False


def first_line(exc: Exception) -> str:
    return (str(exc).strip().splitlines() or [type(exc).__name__])[0]


def dsn(url: URL, **changes: str) -> str:
    return url.set(drivername="postgresql", **changes).render_as_string(hide_password=False)


def connect(url: URL, **changes: str) -> psycopg.Connection:
    return psycopg.connect(dsn(url, **changes), connect_timeout=15)


# ------------------------------------------------------------------------------------------------ checks
def check_identity(url: URL) -> list[Result]:
    with connect(url) as conn:
        user, database, version, superuser, createrole, createdb, bypass = conn.execute(
            "SELECT current_user, current_database(), version(), r.rolsuper, r.rolcreaterole, r.rolcreatedb, "
            "r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user"
        ).fetchone()  # type: ignore[misc]
    results = [
        Result(PASS, "connect", f"{url.host}:{url.port or 5432}/{database} as {user}", required=True),
        Result(INFO, "server", version.split(",")[0]),
        Result(
            INFO,
            "role attributes",
            f"superuser={superuser} createrole={createrole} createdb={createdb} bypassrls={bypass}",
        ),
    ]
    host = url.host or ""
    if "-pooler" in host or (url.port in (6432, 6543)):
        results.append(
            Result(WARN, "pooled connection", "this looks like a transaction pooler; use the direct host for DBOS")
        )
    return results


def probe_role_sql(url: URL, statements: Callable[[sql.Identifier], list[sql.Composed]]) -> None:
    """Run statements for a throwaway role inside a transaction that is always rolled back."""
    name = sql.Identifier(f"tl_probe_{secrets.token_hex(4)}")
    with connect(url) as conn:
        try:
            with conn.transaction():
                for statement in statements(name):
                    conn.execute(statement)
                raise psycopg.Rollback
        except psycopg.Rollback:
            pass


def check_create_role(url: URL) -> Result:
    try:
        probe_role_sql(
            url,
            lambda name: [
                sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'x'").format(
                    name
                )
            ],
        )
    except psycopg.Error as exc:
        return Result(FAIL, "CREATE ROLE ... NOBYPASSRLS", first_line(exc), required=True)
    return Result(PASS, "CREATE ROLE ... NOBYPASSRLS", "allowed (migration 0002 on a fresh database)", required=True)


def check_alter_role(url: URL) -> Result:
    """Migration 0002 only ALTERs the app role when it already exists, for example after a half-finished first try."""
    try:
        probe_role_sql(
            url,
            lambda name: [
                sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'x'").format(
                    name
                ),
                sql.SQL("ALTER ROLE {} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'y'").format(name),
            ],
        )
    except psycopg.Error as exc:
        return Result(
            WARN,
            "ALTER ROLE ... NOBYPASSRLS",
            f"{first_line(exc)}. Only matters if tenderline_app already exists: drop it first, then migrate",
        )
    return Result(PASS, "ALTER ROLE ... NOBYPASSRLS", "allowed (migration 0002 can also re-run over an existing role)")


def check_rls_for_new_role(url: URL) -> Result:
    """Create a login role and a table with a tenant policy, then see what that role can read."""
    suffix = secrets.token_hex(4)
    role, table = f"tl_probe_app_{suffix}", f"tl_probe_rls_{suffix}"
    password = secrets.token_urlsafe(16)
    org_a, org_b = "00000000-0000-0000-0000-00000000000a", "00000000-0000-0000-0000-00000000000b"
    created: list[str] = []
    problem: str | None = None
    verdict: Result | None = None
    try:
        with connect(url) as conn:
            conn.execute(
                sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD {}").format(
                    sql.Identifier(role), sql.Literal(password)
                )
            )
            created.append("role")
            conn.execute(
                sql.SQL("CREATE TABLE {} (organisation_id uuid NOT NULL, note text)").format(sql.Identifier(table))
            )
            created.append("table")
            conn.execute(sql.SQL("ALTER TABLE {} ENABLE ROW LEVEL SECURITY").format(sql.Identifier(table)))
            conn.execute(
                sql.SQL(
                    "CREATE POLICY tenant_isolation ON {} USING (organisation_id = "
                    "NULLIF(current_setting('app.org_id', true), '')::uuid)"
                ).format(sql.Identifier(table))
            )
            conn.execute(
                sql.SQL("INSERT INTO {} VALUES (%s, 'a'), (%s, 'b')").format(sql.Identifier(table)), (org_a, org_b)
            )
            conn.execute(sql.SQL("GRANT SELECT ON {} TO {}").format(sql.Identifier(table), sql.Identifier(role)))
            owner_sees = conn.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone()[0]  # type: ignore[index]

        with connect(url, username=role, password=password) as app:
            bypass = app.execute("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user").fetchone()[0]  # type: ignore[index]
            no_context = app.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone()[0]  # type: ignore[index]
            with app.transaction():
                app.execute("SELECT set_config('app.org_id', %s, true)", (org_a,))
                own_org = app.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone()[0]  # type: ignore[index]
        enforced = not bypass and no_context == 0 and own_org == 1
        detail = (
            f"app role sees {no_context} rows with no organisation set and {own_org} of 2 with one set; "
            f"the table owner sees {owner_sees} (it bypasses RLS by design)"
        )
        verdict = Result(PASS if enforced else FAIL, "RLS enforced for a new app role", detail, required=True)
    except psycopg.Error as exc:
        problem = first_line(exc)
    finally:
        left = cleanup_rls_probe(url, role, table, created)
    if verdict is None:
        verdict = Result(FAIL, "RLS enforced for a new app role", problem or "unknown error", required=True)
    if left:
        verdict.detail += f" | could not remove: {left}; drop them by hand"
    return verdict


def cleanup_rls_probe(url: URL, role: str, table: str, created: list[str]) -> str:
    if not created:
        return ""
    left = []
    try:
        with connect(url) as conn:
            conn.autocommit = True
            if "table" in created:
                try:
                    conn.execute(sql.SQL("DROP TABLE IF EXISTS {}").format(sql.Identifier(table)))
                except psycopg.Error:
                    left.append(f"table {table}")
            if "role" in created:
                try:
                    conn.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role)))
                except psycopg.Error:
                    left.append(f"role {role}")
    except psycopg.Error:
        left = [f"table {table}", f"role {role}"]
    return ", ".join(left)


def check_create_database(url: URL) -> Result:
    name = f"tl_probe_{secrets.token_hex(4)}"
    try:
        with connect(url) as conn:
            conn.autocommit = True
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
            conn.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))
    except psycopg.Error as exc:
        return Result(INFO, "CREATE DATABASE", f"not allowed ({first_line(exc)}); DBOS must share this database")
    return Result(PASS, "CREATE DATABASE", "allowed; DBOS can have a database of its own")


def check_create_schema(url: URL) -> Result:
    name = f"tl_probe_{secrets.token_hex(4)}"
    try:
        with connect(url) as conn:
            try:
                with conn.transaction():
                    conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(name)))
                    conn.execute(sql.SQL("CREATE TABLE {}.t (id int PRIMARY KEY)").format(sql.Identifier(name)))
                    raise psycopg.Rollback
            except psycopg.Rollback:
                pass
    except psycopg.Error as exc:
        return Result(INFO, "CREATE SCHEMA", f"not allowed ({first_line(exc)})")
    return Result(PASS, "CREATE SCHEMA", "allowed; DBOS can keep its tables in a schema of this database")


def check_listen_notify(url: URL) -> Result:
    channel = f"tl_probe_{secrets.token_hex(4)}"
    try:
        with connect(url) as listener, connect(url) as sender:
            listener.autocommit = sender.autocommit = True
            listener.execute(sql.SQL("LISTEN {}").format(sql.Identifier(channel)))
            sender.execute("SELECT pg_notify(%s, 'ping')", (channel,))
            got = next(iter(listener.notifies(timeout=4, stop_after=1)), None)
    except psycopg.Error as exc:
        return Result(WARN, "LISTEN/NOTIFY", f"failed ({first_line(exc)}); set DBOS_USE_LISTEN_NOTIFY=false")
    if got is None:
        return Result(
            WARN,
            "LISTEN/NOTIFY",
            "no notification arrived (typical behind a transaction pooler); set DBOS_USE_LISTEN_NOTIFY=false "
            "before DBOS first creates its tables, because it cannot be changed afterwards",
        )
    return Result(PASS, "LISTEN/NOTIFY", "delivered; DBOS can use its default mode")


# ------------------------------------------------------------------------------------------------ main
def run(url: URL) -> list[Result]:
    results = check_identity(url)
    checks: list[Callable[[URL], Result]] = [
        check_create_role,
        check_alter_role,
        check_rls_for_new_role,
        check_create_database,
        check_create_schema,
        check_listen_notify,
    ]
    for check in checks:
        if check is check_alter_role and any(r.name.startswith("CREATE ROLE") and r.status == FAIL for r in results):
            results.append(Result(INFO, "ALTER ROLE ... NOBYPASSRLS", "skipped, CREATE ROLE already fails"))
            continue
        results.append(check(url))
    placed = any(r.name in ("CREATE DATABASE", "CREATE SCHEMA") and r.status == PASS for r in results)
    results.append(
        Result(
            PASS if placed else FAIL,
            "somewhere for DBOS",
            "a database or a schema can be created" if placed else "neither CREATE DATABASE nor CREATE SCHEMA works",
            required=True,
        )
    )
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "url", nargs="?", default=os.environ.get("DATABASE_URL"), help="owner role URL (or $DATABASE_URL)"
    )
    args = parser.parse_args()
    if not args.url:
        parser.error("give the database URL as an argument or in DATABASE_URL")
    url = make_url(args.url)
    try:
        results = run(url)
    except psycopg.Error as exc:
        print(f"{FAIL}  connect: {first_line(exc)}")
        return 1
    for r in results:
        print(f"{r.status:<5}{r.name}: {r.detail}" if r.detail else f"{r.status:<5}{r.name}")
    failed = [r for r in results if r.required and r.status != PASS]
    print()
    if failed:
        print("NOT READY: " + "; ".join(r.name for r in failed))
        return 1
    print(
        "READY. Required checks passed."
        + (" Review the WARN lines above." if any(r.status == WARN for r in results) else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
