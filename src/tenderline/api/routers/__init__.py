from __future__ import annotations

from fastapi import FastAPI


def register_routers(app: FastAPI) -> None:
    """Additional routers are registered here as each feature area lands."""
    from tenderline.api.routers import notices, opportunities, proposals, searches

    app.include_router(notices.router)
    app.include_router(searches.router)
    app.include_router(opportunities.router)
    app.include_router(proposals.router)
