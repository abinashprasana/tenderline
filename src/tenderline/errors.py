"""One error model for the whole API: {"error": {"code", "message", "details", "request_id"}}."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from tenderline.reqctx import get_request_id


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.details, self.headers = details, headers


def not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"{what} not found")


def forbidden(message: str = "Your role does not allow this action") -> ApiError:
    return ApiError(403, "forbidden", message)


def conflict(code: str, message: str, details: Any = None) -> ApiError:
    return ApiError(409, code, message, details)


def body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details, "request_id": get_request_id()}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(body(exc.code, exc.message, exc.details), exc.status, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        return JSONResponse(body("validation_error", "Request validation failed", details), 422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        codes = {401: "unauthorized", 404: "not_found", 405: "method_not_allowed"}
        code = codes.get(exc.status_code, "http_error")
        return JSONResponse(body(code, str(exc.detail)), exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        from tenderline.observability import record_exception

        record_exception(exc)
        return JSONResponse(body("internal_error", "Internal server error"), 500)
