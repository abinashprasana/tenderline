"""What every endpoint depends on: who is calling, which organisation, what they may do, and idempotency."""

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
from tenderline.db import tenant_session
from tenderline.errors import ApiError, forbidden, not_found
from tenderline.models import IdempotencyKey
from tenderline.security import decode_token

ROLES = ("viewer", "reviewer", "bid_manager", "owner")
READ = ROLES
DECIDE = ("reviewer", "bid_manager", "owner")  # may approve, edit or reject agent proposals
WRITE = ("bid_manager", "owner")  # may manage searches, opportunities and deadlines
ADMIN = ("owner",)  # may manage members and organisation settings

_bearer = HTTPBearer(auto_error=False)


def current_user_id(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]) -> uuid.UUID:
    if credentials is None:
        raise ApiError(401, "unauthorized", "Missing bearer token", headers={"WWW-Authenticate": "Bearer"})
    return decode_token(credentials.credentials)


UserId = Annotated[uuid.UUID, Depends(current_user_id)]


def rate_limited_user_id(user_id: UserId) -> uuid.UUID:
    """For endpoints on shared data, which have no organisation to count against: limit per user."""
    ratelimit.check(user_id)
    return user_id


RateLimitedUserId = Annotated[uuid.UUID, Depends(rate_limited_user_id)]


@dataclass
class TenantContext:
    """One request, scoped to one organisation. `db` is a transaction that can only see that organisation."""

    user_id: uuid.UUID
    org_id: uuid.UUID
    role: str
    db: Session


def tenant_context(org_id: uuid.UUID, user_id: UserId) -> Iterator[TenantContext]:
    """Open the organisation-scoped transaction, check membership inside it, and apply the rate limit."""
    with tenant_session(org_id) as db:
        role = db.execute(text("SELECT app_membership_role(:u, :o)"), {"u": user_id, "o": org_id}).scalar()
        if role is None:
            # 404, not 403: a non-member must not learn whether the organisation exists.
            raise not_found("Organisation")
        ratelimit.check(org_id)
        yield TenantContext(user_id=user_id, org_id=org_id, role=role, db=db)


def require_role(*allowed: str) -> Callable[..., TenantContext]:
    def dependency(context: Annotated[TenantContext, Depends(tenant_context, scope="function")]) -> TenantContext:
        if context.role not in allowed:
            raise forbidden(f"Requires one of roles: {', '.join(allowed)}")
        return context

    return dependency


CanRead = Annotated[TenantContext, Depends(require_role(*READ), scope="function")]
CanDecide = Annotated[TenantContext, Depends(require_role(*DECIDE), scope="function")]
CanWrite = Annotated[TenantContext, Depends(require_role(*WRITE), scope="function")]
IsAdmin = Annotated[TenantContext, Depends(require_role(*ADMIN), scope="function")]

IdempotencyKeyHeader = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=200)]


def run_idempotent(
    db: Session,
    org_id: uuid.UUID,
    key: str,
    request_body: Any,
    handler: Callable[[], tuple[int, Any]],
) -> JSONResponse:
    """Run `handler` at most once per organisation and key, and replay its stored response afterwards.

    The key row is inserted in the caller's transaction, so a second request with the same key waits for the
    first to commit and then replays it. If the handler raises, the transaction rolls back and the key is free
    to be retried. Reusing a key with a different body is an error.
    """
    body_hash = hashlib.sha256(json.dumps(jsonable_encoder(request_body), sort_keys=True).encode()).hexdigest()
    claim = (
        pg_insert(IdempotencyKey)
        .values(organisation_id=org_id, key=key, request_hash=body_hash)
        .on_conflict_do_nothing(index_elements=["organisation_id", "key"])
        .returning(IdempotencyKey.id)
    )
    claimed_id = db.execute(claim).scalar()
    if claimed_id is None:
        earlier = db.scalars(
            select(IdempotencyKey).where(IdempotencyKey.organisation_id == org_id, IdempotencyKey.key == key)
        ).one()
        if earlier.request_hash != body_hash:
            raise ApiError(422, "idempotency_key_reuse", "Idempotency-Key was used with a different request")
        if earlier.response is None:
            raise ApiError(409, "request_in_progress", "A request with this Idempotency-Key is in progress")
        return JSONResponse(earlier.response, earlier.status_code or 200, headers={"Idempotent-Replay": "true"})
    status_code, response_body = handler()
    encoded = jsonable_encoder(response_body)
    db.execute(
        update(IdempotencyKey).where(IdempotencyKey.id == claimed_id).values(status_code=status_code, response=encoded)
    )
    return JSONResponse(encoded, status_code)
