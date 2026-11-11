from __future__ import annotations

import time
import uuid

import jwt

from tenderline.config import get_settings
from tenderline.errors import ApiError

ISSUER = "tenderline"
SESSION_MAX_HOURS = 12  # a refreshed token never outlives the sign-in it came from by more than this


def create_token(user_id: uuid.UUID, ttl_minutes: int | None = None, signed_in_at: int | None = None) -> str:
    s = get_settings()
    now = int(time.time())
    ttl = (ttl_minutes if ttl_minutes is not None else s.jwt_ttl_minutes) * 60
    claims = {"sub": str(user_id), "iat": now, "exp": now + ttl, "iss": ISSUER, "auth_time": signed_in_at or now}
    return jwt.encode(claims, s.jwt_secret, algorithm="HS256")


def decode_claims(token: str) -> dict[str, object]:
    try:
        claims = jwt.decode(
            token,
            get_settings().jwt_secret,
            algorithms=["HS256"],
            issuer=ISSUER,
            options={"require": ["exp", "sub"]},
        )
        uuid.UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError) as exc:
        raise ApiError(
            401, "invalid_token", "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"}
        ) from exc
    return dict(claims)


def decode_token(token: str) -> uuid.UUID:
    return uuid.UUID(str(decode_claims(token)["sub"]))


def refresh_token(token: str) -> tuple[uuid.UUID, str]:
    """Swap a still-valid token for a fresh one, keeping the original sign-in time."""
    claims = decode_claims(token)
    raw_signed_in = claims.get("auth_time", claims.get("iat"))
    signed_in_at = raw_signed_in if isinstance(raw_signed_in, int) else 0
    if time.time() - signed_in_at > SESSION_MAX_HOURS * 3600:
        raise ApiError(401, "session_expired", "Sign in again", headers={"WWW-Authenticate": "Bearer"})
    user_id = uuid.UUID(str(claims["sub"]))
    return user_id, create_token(user_id, signed_in_at=signed_in_at)
