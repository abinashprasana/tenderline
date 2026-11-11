from __future__ import annotations

import time
import uuid

import jwt

from tenderline.config import get_settings
from tenderline.errors import ApiError

ISSUER = "tenderline"


def create_token(user_id: uuid.UUID, ttl_minutes: int | None = None) -> str:
    s = get_settings()
    now = int(time.time())
    ttl = (ttl_minutes if ttl_minutes is not None else s.jwt_ttl_minutes) * 60
    claims = {"sub": str(user_id), "iat": now, "exp": now + ttl, "iss": ISSUER}
    return jwt.encode(claims, s.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> uuid.UUID:
    try:
        claims = jwt.decode(
            token,
            get_settings().jwt_secret,
            algorithms=["HS256"],
            issuer=ISSUER,
            options={"require": ["exp", "sub"]},
        )
        return uuid.UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError) as exc:
        raise ApiError(
            401, "invalid_token", "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"}
        ) from exc
