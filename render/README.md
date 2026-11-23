# Deploying to Render (free, no card)

One free Render web service runs the API and serves the web app on the same origin, so there is no proxy and no
CORS. Everything for it is in this folder: `Dockerfile`, `render.yaml`, `entrypoint.py` and `check_db_privileges.py`.
The Oracle setup (`terraform/`, `docker-compose*.yml`, Caddy) is untouched.

## What changed in the app

All of it is off by default, so the compose stacks and the tests behave as before.

| Variable | Default | Effect |
|:--|:--|:--|
| `SERVE_WEB_DIR` | empty | The API serves the built web app from this folder, with the routing of `frontend/caddy/tenderline.caddy`. `render/Dockerfile` sets it. |
| `DB_POOL_SIZE`, `DB_MAX_OVERFLOW` | 10, 20 | Connection pool of the app database. `render.yaml` uses 3 and 2. |
| `DBOS_SYS_DB_POOL_SIZE` | DBOS default | Pool of DBOS's own connections. `render.yaml` uses 5. |
| `DBOS_USE_LISTEN_NOTIFY` | true | `false` makes DBOS poll instead of using LISTEN/NOTIFY. Only for a pooled database connection. |

## Limits of the free plan

**Render web service** ([docs](https://render.com/docs/free))
- Spins down after 15 minutes without a request and takes about a minute to wake. While it sleeps nothing runs, including the daily ingestion.
- 750 free instance hours per **workspace** per month, shared by every free web service in it. One service awake all month uses about 744, and when the hours run out Render suspends all of the workspace's free services until the next month.
- No shell, no persistent disk, 512 MB RAM.

**Render Postgres** (free)
- Expires **30 days** after creation, then 14 days to upgrade before it is deleted. No backups. 1 GB.
- No managed connection pooling, so LISTEN/NOTIFY works.

**Neon** (free, [docs](https://neon.com/docs/introduction/plans))
- 100 compute-unit hours per project per month, about 400 hours at the smallest size, and 1 GB.
- Compute stops after 5 minutes without activity. DBOS polls the database all the time (its scheduler, the approval
  reconciler every 2 minutes), so the compute never sleeps and a month is about 744 hours. Expect the allowance to
  run out around day 16.
- Use the direct host. The `-pooler` host cannot carry LISTEN/NOTIFY (set `DBOS_USE_LISTEN_NOTIFY=false` if you
  must use it, before the first start).
- Render counts traffic to an outside database as service-initiated traffic and may suspend a service that sends a lot of it. This app sends very little.

Neither database lasts a month of continuous use for free. Render's costs you the data after 30 days but is simple to
recreate: notices are public and come back with the next ingestion.

## How it starts

`entrypoint.py` runs first. From `DATABASE_URL` it builds the three URLs Tenderline wants (owner, `tenderline_app`
with `APP_DB_PASSWORD`, and DBOS in the same database, in its own `dbos` schema). It sets `APP_VERSION` from
`RENDER_GIT_COMMIT` so DBOS resumes work after each deploy, and `GITHUB_REDIRECT_URI` from `RENDER_EXTERNAL_URL`.
Anything you set by hand wins. Then `tenderline serve` migrates and starts the API and the DBOS workers in one process.

## Measured

Run locally with the image from `Dockerfile.render`, `ENV=prod`, a 512 MB limit and a non-superuser database owner.

| | |
|:--|:--|
| Image size | 369 MB (the API-only image is 356 MB) |
| Cold start to `/readyz` 200 | 7 s normally, 55 s limited to 0.1 CPU (migrations and 9,454 CPV labels included) |
| Memory after start | 94 MiB of 512 |
| After 120 page and API requests | 105 MiB |
| After `tenderline demo` (392 real TED notices, 245 suggestions, 2 approvals run) | 103 MiB, with `DBOS_USE_LISTEN_NOTIFY=false` |

## Check the database first

Migration 0002 creates the `tenderline_app` role with `CREATE ROLE ... NOBYPASSRLS`. A managed database may not allow
that. With the owner URL (from your computer; the password is never printed):

```bash
uv run python render/check_db_privileges.py "postgresql://user:password@host/dbname"
```

It also logs in as a throwaway role to prove row-level security hides other organisations' rows, and tests LISTEN/NOTIFY.
It removes everything it creates. If it says NOT READY, do not deploy: the app would run without tenant isolation or not at all.

Postgres 16 lets a role with CREATEROLE create `tenderline_app` but not alter it afterwards, and roles belong to the whole
database server. So give each Tenderline database its own server. A second one on the same server fails in migration 0002,
which finds the role and tries to alter it; the checker shows this as the ALTER ROLE warning.

## Keep it awake (optional)

Check first that nothing else free in the workspace needs the hours: a service kept awake all month leaves about 6 of the
750. Without a ping the service just sleeps and wakes in about a minute for the next visitor, which is fine for a demo.

`/healthz` is public and does not touch the database. To keep it awake, ping it every 10 minutes from
[cron-job.org](https://cron-job.org) (free, no card), ideally only in the hours you need:

1. Create a job with the URL `https://<your-service>.onrender.com/healthz`.
2. Schedule: every 10 minutes. Request method GET. Expected status 200.

This also keeps the 06:00 UTC ingestion alive. If the service sleeps through it, DBOS does **not** run it on wake-up
(it re-arms schedules at most 30 seconds back and automatic backfill is off). Nothing is lost: the next run starts from
the last success minus 7 days, and `tenderline ingest` runs it on demand.

## Your steps

1. **GitHub OAuth app.** GitHub, Settings, Developer settings, OAuth Apps, New. Homepage URL `https://<service>.onrender.com`,
   callback URL `https://<service>.onrender.com/auth/callback`. Keep the client id and generate a client secret.
   Sign-in is GitHub only because `ENV=prod` turns off the local sign-in.
2. **Render service.** Dashboard, New, Blueprint. Use the public repository URL (no GitHub permission needed, but then
   there is no auto-deploy: use Manual sync to pick up new commits), the `render-deploy` branch, and Blueprint Path
   `render/render.yaml`. Enter `GITHUB_CLIENT_ID`
   and `GITHUB_CLIENT_SECRET` when asked. The first build takes several minutes on the free plan.
3. If the service URL has a suffix (`tenderline-ab12.onrender.com`), use that exact URL in the GitHub OAuth app.
4. **cron-job.org.** As above.
5. **First notices.** The ingestion runs at 06:00 UTC. To fill the app now, from your computer, with the database's
   external URL (the one starting `postgresql://`, not the internal one):
   `DBOS_SYSTEM_DATABASE_URL=<external database URL> uv run tenderline ingest`.
   CLI commands need that variable set by hand, because only the server process gets the URLs the entrypoint derives.

To use Groq instead of the fake assistant, set `LLM_PROVIDER_CHAIN=groq,fake` and add `GROQ_API_KEY` in the dashboard.
