from __future__ import annotations

import secrets
import time
import uuid
from typing import Annotated, Any

import httpx
import jwt
from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from tenderline.api.deps import ROLES, UserId
from tenderline.config import get_settings
from tenderline.db import public_session, tenant_session
from tenderline.errors import ApiError, not_found
from tenderline.models import Membership, User
from tenderline.security import create_token

router = APIRouter(prefix="/v1", tags=["auth"])

GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN = "https://github.com/login/oauth/access_token"  # noqa: S105
GITHUB_USER = "https://api.github.com/user"


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105
    user_id: uuid.UUID
    login: str


class DevTokenIn(BaseModel):
    login: str = Field(min_length=1, max_length=100)
    organisation_id: uuid.UUID | None = None
    role: str = "owner"


def _state_token() -> str:
    s = get_settings()
    claims = {"n": secrets.token_urlsafe(12), "exp": int(time.time()) + 600, "p": "gh-oauth"}
    return jwt.encode(claims, s.jwt_secret, algorithm="HS256")


def _check_state(state: str) -> None:
    try:
        claims = jwt.decode(state, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise ApiError(400, "invalid_state", "OAuth state is invalid or expired") from exc
    if claims.get("p") != "gh-oauth":
        raise ApiError(400, "invalid_state", "OAuth state is invalid")


@router.get("/auth/github/login", summary="Start GitHub OAuth login")
def github_login() -> dict[str, str]:
    s = get_settings()
    if not s.github_client_id or not s.github_client_secret:
        raise ApiError(503, "github_oauth_not_configured", "GitHub OAuth is not configured (see SETUP.md)")
    params = httpx.QueryParams(
        {
            "client_id": s.github_client_id,
            "redirect_uri": s.github_redirect_uri,
            "scope": "read:user user:email",
            "state": _state_token(),
        }
    )
    return {"authorize_url": f"{GITHUB_AUTHORIZE}?{params}"}


@router.get("/auth/github/callback", response_model=TokenOut, summary="GitHub OAuth callback; issues a JWT")
def github_callback(code: Annotated[str, Query()], state: Annotated[str, Query()]) -> TokenOut:
    s = get_settings()
    if not s.github_client_id:
        raise ApiError(503, "github_oauth_not_configured", "GitHub OAuth is not configured (see SETUP.md)")
    _check_state(state)
    try:
        with httpx.Client(timeout=15) as client:
            tok = client.post(
                GITHUB_TOKEN,
                json={
                    "client_id": s.github_client_id,
                    "client_secret": s.github_client_secret,
                    "code": code,
                    "redirect_uri": s.github_redirect_uri,
                },
                headers={"Accept": "application/json"},
            ).json()
            access = tok.get("access_token")
            if not access:
                raise ApiError(400, "oauth_exchange_failed", "GitHub rejected the authorisation code")
            gh: dict[str, Any] = client.get(
                GITHUB_USER,
                headers={"Authorization": f"Bearer {access}", "Accept": "application/vnd.github+json"},
            ).json()
    except httpx.HTTPError as exc:
        raise ApiError(502, "github_unreachable", "Could not reach GitHub") from exc
    with public_session() as db:
        stmt = (
            pg_insert(User)
            .values(github_id=gh["id"], login=gh["login"], email=gh.get("email"), name=gh.get("name"))
            .on_conflict_do_update(
                index_elements=["github_id"],
                set_={"login": gh["login"], "email": gh.get("email"), "name": gh.get("name")},
            )
            .returning(User.id)
        )
        user_id = db.execute(stmt).scalar_one()
    return TokenOut(access_token=create_token(user_id), user_id=user_id, login=gh["login"])


@router.post("/auth/dev-token", response_model=TokenOut, summary="DEV ONLY: mint a token without OAuth")
def dev_token(payload: DevTokenIn) -> TokenOut:
    if not get_settings().is_dev:
        raise not_found("Resource")  # indistinguishable from an unknown route outside ENV=dev
    if payload.role not in ROLES:
        raise ApiError(422, "invalid_role", f"role must be one of {ROLES}")
    with public_session() as db:
        user = db.scalars(select(User).where(User.login == payload.login, User.github_id.is_(None))).first()
        if user is None:
            user = User(login=payload.login, name=payload.login)
            db.add(user)
            db.flush()
        user_id, login = user.id, user.login
    if payload.organisation_id:
        with tenant_session(payload.organisation_id) as db:
            if not db.execute(
                text("SELECT 1 FROM organisations WHERE id = :o"), {"o": payload.organisation_id}
            ).first():
                raise not_found("Organisation")
            stmt = (
                pg_insert(Membership)
                .values(organisation_id=payload.organisation_id, user_id=user_id, role=payload.role)
                .on_conflict_do_update(index_elements=["organisation_id", "user_id"], set_={"role": payload.role})
            )
            db.execute(stmt)
    return TokenOut(access_token=create_token(user_id), user_id=user_id, login=login)


@router.get("/me", summary="Current user and organisation memberships")
def me(user_id: UserId) -> dict[str, Any]:
    with public_session() as db:
        user = db.get(User, user_id)
        if user is None:
            raise ApiError(401, "invalid_token", "User no longer exists")
        rows = db.execute(text("SELECT org_id, role FROM app_user_memberships(:u)"), {"u": user_id}).all()
    return {
        "id": str(user.id),
        "login": user.login,
        "name": user.name,
        "memberships": [{"organisation_id": str(o), "role": r} for o, r in rows],
    }
