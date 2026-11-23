"""Container entrypoint for the Render deployment (see docs/render.md).

Render hands the service one database URL and a few RENDER_* variables. Tenderline wants three database URLs
(table owner, the RLS-subject app role, and DBOS's system database), an application version and an OAuth
redirect URI. This works them out, then starts `tenderline serve`.

It only fills in what is not already set, so any of these can still be set by hand in the dashboard.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping

from sqlalchemy.engine import make_url

APP_ROLE = "tenderline_app"  # created by migration 0002


def derive(env: Mapping[str, str]) -> dict[str, str]:
    """The variables to add to `env`. Raises SystemExit with a readable message when something is missing."""
    out: dict[str, str] = {}

    raw = env.get("DATABASE_URL", "").strip()
    if not raw:
        raise SystemExit("DATABASE_URL is not set: give the service the connection string of its Postgres database")
    base = make_url(raw)

    # SQLAlchemy needs the psycopg driver named; providers hand out plain postgres:// or postgresql://.
    owner = base.set(drivername="postgresql+psycopg")
    out["DATABASE_URL"] = owner.render_as_string(hide_password=False)

    if not env.get("APP_DATABASE_URL"):
        password = env.get("APP_DB_PASSWORD", "")
        if not password:
            raise SystemExit("APP_DB_PASSWORD is not set: it is the password of the role migration 0002 creates")
        out["APP_DATABASE_URL"] = owner.set(username=APP_ROLE, password=password).render_as_string(hide_password=False)

    # DBOS keeps its tables in their own schema ("dbos"), so it can share the application's database.
    if not env.get("DBOS_SYSTEM_DATABASE_URL"):
        out["DBOS_SYSTEM_DATABASE_URL"] = base.set(drivername="postgresql").render_as_string(hide_password=False)

    # DBOS resumes only the workflows of its own application version, so it must change with each deploy.
    if not env.get("APP_VERSION") and env.get("RENDER_GIT_COMMIT"):
        out["APP_VERSION"] = env["RENDER_GIT_COMMIT"][:12]

    # The service's own public URL; it must also be the callback URL of the GitHub OAuth app.
    if not env.get("GITHUB_REDIRECT_URI") and env.get("RENDER_EXTERNAL_URL"):
        out["GITHUB_REDIRECT_URI"] = env["RENDER_EXTERNAL_URL"].rstrip("/") + "/auth/callback"

    # uvicorn reads this and would start several copies of the app (and of DBOS) in one small container.
    if not env.get("WEB_CONCURRENCY"):
        out["WEB_CONCURRENCY"] = "1"

    return out


def main() -> None:
    os.environ.update(derive(os.environ))
    port = os.environ.get("PORT", "10000")
    os.execvp("tenderline", ["tenderline", "serve", "--port", port])  # noqa: S606, S607


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        if isinstance(exc.code, str):
            print(f"render_entrypoint: {exc.code}", file=sys.stderr)
            sys.exit(1)
        raise
