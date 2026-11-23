from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Response
from pydantic import BaseModel
from sqlalchemy import text

from tenderline import __version__
from tenderline.api.routers import auth, orgs
from tenderline.config import get_settings
from tenderline.db import public_session
from tenderline.errors import install_error_handlers
from tenderline.observability import instrument_app, record_http, setup_telemetry, timer
from tenderline.reqctx import set_request_id

DEFAULT_SECRETS = {"dev-only-change-me-dev-only-change-me"}

LICENCE: dict[str, Any] = {
    "ted": {
        "name": "TED - Tenders Electronic Daily",
        "publisher": "Publications Office of the European Union",
        "source": "https://ted.europa.eu",
        "terms": "https://ted.europa.eu/en/legal-notice",
        "attribution": "Contains procurement notice data from TED (https://ted.europa.eu), (c) European Union. "
        "Reuse is subject to the TED legal notice linked in `terms`.",
    },
    "etenders": {
        "name": "Contract Notices Published on eTenders",
        "source": "https://data.gov.ie",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": "Contains Irish public sector information from the dataset 'Contract Notices Published on "
        "eTenders' via data.gov.ie, licensed under CC BY 4.0. Check the dataset page for the current publisher "
        "credit line.",
    },
    "free_text_policy": "Buyer free text is not republished; only a short summary field and a link to the source "
    "notice are stored in structured form.",
}


class MetadataOut(BaseModel):
    name: str
    version: str
    env: str
    api_version: str
    contact: str | None
    data_sources: dict[str, Any]
    disclaimer: str
    ingest_cron: str


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    s = get_settings()
    if s.env == "prod" and s.jwt_secret in DEFAULT_SECRETS:
        raise RuntimeError("JWT_SECRET must be set to a unique value when ENV=prod")
    from tenderline.workflows.runtime import start_runtime, stop_runtime

    # DBOS's sync API refuses to run inside a live event loop, so start/stop it from a worker thread.
    started_here = await asyncio.to_thread(start_runtime) if s.workflows_enabled else False
    try:
        yield
    finally:
        if started_here:
            await asyncio.to_thread(stop_runtime)


def create_app() -> FastAPI:
    app = FastAPI(
        title="Tenderline API",
        version=__version__,
        description="Multi-tenant public procurement tracking with human-approved AI proposals.",
        lifespan=lifespan,
    )
    setup_telemetry()
    install_error_handlers(app)
    instrument_app(app)

    @app.middleware("http")
    async def request_id_mw(request: Request, call_next: Any) -> Response:
        rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        set_request_id(rid)
        started = timer()
        status = 500
        try:
            response: Response = await call_next(request)
            status = response.status_code
        finally:
            route = request.scope.get("route")
            record_http(request.method, getattr(route, "path", "unmatched"), status, timer() - started)
        response.headers["X-Request-ID"] = rid
        return response

    @app.get("/healthz", tags=["ops"], summary="Liveness")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz", tags=["ops"], summary="Readiness: database reachable and migrated")
    def readyz(response: Response) -> dict[str, Any]:
        try:
            with public_session() as s:
                s.execute(text("SELECT 1"))
                s.execute(text("SELECT count(*) FROM notices"))
        except Exception as exc:  # noqa: BLE001
            response.status_code = 503
            return {"status": "unavailable", "detail": type(exc).__name__}
        return {"status": "ready"}

    @app.get(
        "/v1/metadata",
        response_model=MetadataOut,
        tags=["ops"],
        summary="Version, data sources, licences and attribution",
    )
    def metadata() -> dict[str, Any]:
        s = get_settings()
        return {
            "name": "tenderline",
            "version": __version__,
            "env": s.env,
            "api_version": "v1",
            "contact": s.contact_email,
            "data_sources": LICENCE,
            "ingest_cron": s.ingest_cron,
            "disclaimer": "Tenderline provides information and AI-generated proposals only. It does not give legal "
            "or procurement advice; a human decides every action.",
        }

    app.include_router(auth.router)
    app.include_router(orgs.router)
    from tenderline.api.routers import register_routers

    register_routers(app)
    if web_dir := get_settings().serve_web_dir:  # off by default; Caddy serves the web app in the compose stacks
        from tenderline.api.webapp import mount_web

        mount_web(app, web_dir)
    return app


app = create_app()
