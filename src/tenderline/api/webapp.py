"""Serve the built web app from the API process, on the same origin as the API.

Off by default. With `SERVE_WEB_DIR` set, the routing is the one in frontend/caddy/tenderline.caddy:

* `/v1/*`, `/healthz`, `/readyz`, `/docs`, `/docs/*`, `/openapi.json` and `/redoc` belong to the API. A path under
  them that no route handles stays a JSON 404; it never falls through to the web app.
* `/assets/*` are hashed build files: long-lived caching, and a missing one is a 404, never the app's HTML.
* Everything else is the single-page app: a real file in the build is served as it is, any other path gets
  `index.html` and the client-side router takes over (this is what makes `/auth/callback` work).

The compose stacks keep using Caddy; this exists for hosts that run a single container.
"""

from __future__ import annotations

import mimetypes
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import FastAPI
from starlette.exceptions import HTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, Response

# Kept identical to frontend/caddy/tenderline.caddy (a unit test compares the two).
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; "
    "frame-ancestors 'none'"
)
PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()"

API_EXACT = frozenset({"/healthz", "/readyz", "/docs", "/openapi.json", "/redoc"})
API_PREFIXES = ("/v1/", "/docs/")

IMMUTABLE = "public, max-age=31536000, immutable"


def is_api_path(path: str) -> bool:
    return path in API_EXACT or path.startswith(API_PREFIXES)


def _inside(root: Path, rel: str) -> Path | None:
    """The file `rel` names inside `root`, or None when it is missing or points outside `root`."""
    try:
        candidate = (root / rel.lstrip("/")).resolve()
        candidate.relative_to(root)
    except (ValueError, OSError):
        return None
    return candidate if candidate.is_file() else None


def mount_web(app: FastAPI, directory: str) -> None:
    root = Path(directory).resolve()
    index = root / "index.html"
    if not index.is_file():
        raise RuntimeError(f"SERVE_WEB_DIR={directory!r} has no index.html; build the web app first")

    # Python's table varies by platform; the 3D model and fonts must not be served as the wrong type.
    for extension, kind in ((".gltf", "model/gltf+json"), (".webp", "image/webp"), (".woff2", "font/woff2")):
        mimetypes.add_type(kind, extension)

    async def serve(request: Request) -> Response:
        path = request.url.path
        if is_api_path(path):
            raise HTTPException(status_code=404)  # the API's own JSON 404
        if path.startswith("/assets/"):
            asset = _inside(root, path)
            if asset is None:
                raise HTTPException(status_code=404)
            return FileResponse(asset, headers={"Cache-Control": IMMUTABLE})
        target = _inside(root, path) or index
        return FileResponse(
            target,
            headers={
                "Cache-Control": "no-cache",
                "Content-Security-Policy": CONTENT_SECURITY_POLICY,
                "Permissions-Policy": PERMISSIONS_POLICY,
            },
        )

    # Added after every API route, so it only sees what the API did not claim.
    app.router.add_route("/{path:path}", serve, methods=["GET", "HEAD"], include_in_schema=False)

    @app.middleware("http")
    async def baseline_headers(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)
