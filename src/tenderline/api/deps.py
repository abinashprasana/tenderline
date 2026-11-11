"""FastAPI dependency layer: authentication, tenant context, role checks, idempotency."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Depends, Header
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from tenderline import ratelimit
from tenderline.db import public_session, tenant_session
from tenderline.errors import ApiError, forbidden, not_found
from tenderline.models import IdempotencyKey
from tenderline.security import decode_token

ROLES = ("viewer", "reviewer", "bid_manager", "owner")
READ = ROLES
DECIDE = ("reviewer", "bid_manager", "owner")  # may approve / edit / reject agent proposals
WRITE = ("bid_manager", "owner")  # may manage searches, opportunities, deadlines
ADMIN = ("owner",)  # members, organisation settings

_bearer = HTTPBearer(auto_error=False)


def current_user_id(creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]) -> uuid.UUID:
    if creds is None:
        raise ApiError(401, "unauthorized", "Missing bearer token", headers={"WWW-Authenticate": "Bearer"})
    return decode_token(creds.credentials)


UserId = Annotated[uuid.UUID, Depends(current_user_id)]


@dataclass
class Ctx:
    user_id: uuid.UUID
    org_id: uuid.UUID
    role: str
    db: Session

    @property
    def actor(self) -> tuple[str, str]:
        return "human", str(self.user_id)


def org_ctx(org_id: uuid.UUID, user_id: UserId) -> Iterator[Ctx]:
    """Resolve membership, apply the per-org rate limit, and open the tenant-scoped transaction."""
    with public_session() as s:
        role = s.execute(text("SELECT app_membership_role(:u, :o)"), {"u": user_id, "o": org_id}).scalar()
    if role is None:
        # 404, not 403: do not reveal whether an organisation id exists.
        raise not_found("Organisation")
    ratelimit.check(org_id)
    with tenant_session(org_id) as db:
        yield Ctx(user_id=user_id, org_id=org_id, role=role, db=db)


def require(*allowed: str) -> Callable[..., Ctx]:
    def _dep(ctx: Annotated[Ctx, Depends(org_ctx, scope="function")]) -> Ctx:
        if ctx.role not in allowed:
            raise forbidden(f"Requires one of roles: {', '.join(allowed)}")
        return ctx

    return _dep


CanRead = Annotated[Ctx, Depends(require(*READ), scope="function")]
CanDecide = Annotated[Ctx, Depends(require(*DECIDE), scope="function")]
CanWrite = Annotated[Ctx, Depends(require(*WRITE), scope="function")]
IsAdmin = Annotated[Ctx, Depends(require(*ADMIN), scope="function")]

IdemKey = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=200)]


def idempotent(
    db: Session,
    org_id: uuid.UUID,
    key: str,
    payload: Any,
    handler: Callable[[], tuple[int, Any]],
) -> JSONResponse:
    """Run `handler` at most once per (organisation, key). Replays the stored response afterwards."""
    digest = hashlib.sha256(json.dumps(jsonable_encoder(payload), sort_keys=True).encode()).hexdigest()
    ins = (
        pg_insert(IdempotencyKey)
        .values(organisation_id=org_id, key=key, request_hash=digest)
        .on_conflict_do_nothing(index_elements=["organisation_id", "key"])
        .returning(IdempotencyKey.id)
    )
    row_id = db.execute(ins).scalar()
    if row_id is None:
        existing = db.scalars(
            select(IdempotencyKey).where(IdempotencyKey.organisation_id == org_id, IdempotencyKey.key == key)
        ).one()
        if existing.request_hash != digest:
            raise ApiError(422, "idempotency_key_reuse", "Idempotency-Key was used with a different request")
        if existing.response is None:
            raise ApiError(409, "request_in_progress", "A request with this Idempotency-Key is in progress")
        return JSONResponse(
            existing.response, existing.status_code or 200, headers={"Idempotent-Replay": "true"}
        )
    status, data = handler()
    encoded = jsonable_encoder(data)
    db.execute(
        update(IdempotencyKey).where(IdempotencyKey.id == row_id).values(status_code=status, response=encoded)
    )
    return JSONResponse(encoded, status)
