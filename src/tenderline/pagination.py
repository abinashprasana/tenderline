"""Opaque keyset (cursor) pagination over (sort column, id), newest first."""

from __future__ import annotations

import base64
import json
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, or_
from sqlalchemy.orm import InstrumentedAttribute, Session

from tenderline.errors import ApiError

MAX_LIMIT = 200


def encode_cursor(sort_value: Any, row_id: Any) -> str:
    sv = sort_value.isoformat() if hasattr(sort_value, "isoformat") else sort_value
    raw = json.dumps({"s": sv, "i": str(row_id)}).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[Any, str]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        return data["s"], data["i"]
    except (ValueError, KeyError, TypeError) as exc:
        raise ApiError(400, "invalid_cursor", "Malformed pagination cursor") from exc


def paginate(
    db: Session,
    stmt: Select[Any],
    sort_col: InstrumentedAttribute[Any],
    id_col: InstrumentedAttribute[Any],
    cursor: str | None,
    limit: int,
) -> tuple[list[Any], str | None]:
    limit = max(1, min(limit, MAX_LIMIT))
    if cursor:
        s_raw, i_raw = decode_cursor(cursor)
        py_type = sort_col.type.python_type
        try:
            s_val: Any = s_raw
            if py_type is datetime:
                s_val = datetime.fromisoformat(s_raw)
            elif py_type is date:
                s_val = date.fromisoformat(s_raw)
            i_val: Any = UUID(i_raw) if id_col.type.python_type is UUID else int(i_raw)
        except (ValueError, TypeError) as exc:
            raise ApiError(400, "invalid_cursor", "Malformed pagination cursor") from exc
        stmt = stmt.where(or_(sort_col < s_val, and_(sort_col == s_val, id_col < i_val)))
    stmt = stmt.order_by(sort_col.desc(), id_col.desc()).limit(limit + 1)
    rows = list(db.scalars(stmt))
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        next_cursor = encode_cursor(getattr(last, sort_col.key), getattr(last, id_col.key))
    return rows, next_cursor
