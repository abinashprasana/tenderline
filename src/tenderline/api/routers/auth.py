from __future__ import annotations

import secrets
import time
import uuid
from typing import Annotated, Any

import httpx
import jwt
from fastapi import APIRouter, Cookie, Depends, Query, Response
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from tenderline.api.deps import ROLES, UserId, bearer_credentials
from tenderline.config import get_settings
from tenderline.db import public_session, tenant_session
from tenderline.errors import ApiError, not_found
from tenderline.models import Membership, User
from tenderline.security import create_token, refresh_token

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


STATE_COOKIE = "tenderline_oauth_state"
STATE_TTL_SECONDS = 600


def _new_state() -> tuple[str, str]:
    """Return (state, nonce). The signed state goes to GitHub; the nonce goes into a cookie on this browser."""
    nonce = secrets.token_urlsafe(24)
    claims = {"nonce": nonce, "exp": int(time.time()) + STATE_TTL_SECONDS, "purpose": "github-oauth"}
    return jwt.encode(claims, get_settings().jwt_secret, algorithm="HS256"), nonce


def _check_state(state: str, cookie_nonce: str | None) -> None:
    """The state must be ours, unexpired, and issued to the browser that is now completing the login.

    Without the cookie check an attacker could start a login, then get a victim's browser to finish it and
    leave the victim signed in to the attacker's account (login CSRF).
    """
    try:
        claims = jwt.decode(state, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise ApiError(400, "invalid_state", "OAuth state is invalid or expired") from exc
    nonce = str(claims.get("nonce", ""))
    if claims.get("purpose") != "github-oauth" or not cookie_nonce or not secrets.compare_digest(nonce, cookie_nonce):
        raise ApiError(400, "invalid_state", "OAuth state does not belong to this browser session")


@router.get("/auth/github/login", summary="Start GitHub OAuth login")
def github_login(response: Response) -> dict[str, str]:
    settings = get_settings()
    if not settings.github_client_id or not settings.github_client_secret:
        raise ApiError(503, "github_oauth_not_configured", "GitHub OAuth is not configured (see SETUP.md)")
    state, nonce = _new_state()
    response.set_cookie(
        STATE_COOKIE,
        nonce,
        max_age=STATE_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=settings.github_redirect_uri.startswith("https://"),
        path="/v1/auth/github",
    )
    params = httpx.QueryParams(
        {
            "client_id": settings.github_client_id,
            "redirect_uri": settings.github_redirect_uri,
            "scope": "read:user user:email",
            "state": state,
        }
    )
    return {"authorize_url": f"{GITHUB_AUTHORIZE}?{params}"}


@router.get("/auth/github/callback", response_model=TokenOut, summary="GitHub OAuth callback; issues a JWT")
def github_callback(
    code: Annotated[str, Query()],
    state: Annotated[str, Query()],
    response: Response,
    state_nonce: Annotated[str | None, Cookie(alias=STATE_COOKIE)] = None,
) -> TokenOut:
    settings = get_settings()
    if not settings.github_client_id:
        raise ApiError(503, "github_oauth_not_configured", "GitHub OAuth is not configured (see SETUP.md)")
    _check_state(state, state_nonce)
    response.delete_cookie(STATE_COOKIE, path="/v1/auth/github")
    try:
        with httpx.Client(timeout=15) as github:
            token_reply = github.post(
                GITHUB_TOKEN,
                json={
                    "client_id": settings.github_client_id,
                    "client_secret": settings.github_client_secret,
                    "code": code,
                    "redirect_uri": settings.github_redirect_uri,
                },
                headers={"Accept": "application/json"},
            ).json()
            access_token = token_reply.get("access_token") if isinstance(token_reply, dict) else None
            if not access_token:
                raise ApiError(400, "oauth_exchange_failed", "GitHub rejected the authorisation code")
            profile = github.get(
                GITHUB_USER,
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/vnd.github+json"},
            ).json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ApiError(502, "github_unreachable", "Could not reach GitHub") from exc
    # GitHub answers errors (rate limit, revoked token) with a JSON body that has no id or login.
    if not isinstance(profile, dict) or not isinstance(profile.get("id"), int) or not profile.get("login"):
        raise ApiError(502, "github_profile_unavailable", "GitHub did not return a user profile")
    with public_session() as db:
        upsert = (
            pg_insert(User)
            .values(
                github_id=profile["id"], login=profile["login"], email=profile.get("email"), name=profile.get("name")
            )
            .on_conflict_do_update(
                index_elements=["github_id"],
                set_={"login": profile["login"], "email": profile.get("email"), "name": profile.get("name")},
            )
            .returning(User.id)
        )
        user_id = db.execute(upsert).scalar_one()
    return TokenOut(access_token=create_token(user_id), user_id=user_id, login=profile["login"])


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


@router.post("/auth/refresh", response_model=TokenOut, summary="Swap a valid token for a fresh one")
def refresh(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_credentials)]) -> TokenOut:
    """Keeps a working session alive past the token lifetime, up to 12 hours after the original sign-in."""
    if credentials is None:
        raise ApiError(401, "unauthorized", "Missing bearer token", headers={"WWW-Authenticate": "Bearer"})
    user_id, token = refresh_token(credentials.credentials)
    with public_session() as db:
        user = db.get(User, user_id)
        if user is None:
            raise ApiError(401, "invalid_token", "User no longer exists")
        login = user.login
    return TokenOut(access_token=token, user_id=user_id, login=login)


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
