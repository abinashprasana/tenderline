from __future__ import annotations

from fastapi import FastAPI


def register_routers(app: FastAPI) -> None:
    """Additional routers are registered here as each feature area lands."""
    from tenderline.api.routers import notices

    app.include_router(notices.router)
