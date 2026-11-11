"""Opaque keyset (cursor) pagination over (sort value, id).

Keyset pagination stays fast and stable while rows are being added, unlike OFFSET. The cursor is an opaque
base64 string; clients pass back whatever `next_cursor` they received.
"""

from __future__ import annotations

import base64
import json
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, func, literal, or_
from sqlalchemy.orm import InstrumentedAttribute, Session

from tenderline.errors import ApiError

MAX_LIMIT = 200


def encode_cursor(sort_value: Any, row_id: Any) -> str:
    serialised = sort_value.isoformat() if hasattr(sort_value, "isoformat") else sort_value
    raw = json.dumps({"s": serialised, "i": str(row_id)}).encode()
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
    *,
    descending: bool = True,
    null_as: Any = None,
) -> tuple[list[Any], str | None]:
    """Return one page of rows and the cursor for the next page (None on the last page).

    `null_as` lets a nullable column take part: NULLs sort as that value (for example a far-future date to
    put rows without a deadline last when sorting soonest first).
    """
    limit = max(1, min(limit, MAX_LIMIT))
    sort_expr: Any = func.coalesce(sort_col, literal(null_as, sort_col.type)) if null_as is not None else sort_col
    if cursor:
        raw_sort, raw_id = decode_cursor(cursor)
        python_type = sort_col.type.python_type
        try:
            sort_value: Any = raw_sort
            if python_type is datetime:
                sort_value = datetime.fromisoformat(raw_sort)
            elif python_type is date:
                sort_value = date.fromisoformat(raw_sort)
            id_value: Any = UUID(raw_id) if id_col.type.python_type is UUID else int(raw_id)
        except (ValueError, TypeError) as exc:
            raise ApiError(400, "invalid_cursor", "Malformed pagination cursor") from exc
        if descending:
            stmt = stmt.where(or_(sort_expr < sort_value, and_(sort_expr == sort_value, id_col < id_value)))
        else:
            stmt = stmt.where(or_(sort_expr > sort_value, and_(sort_expr == sort_value, id_col > id_value)))
    order = (sort_expr.desc(), id_col.desc()) if descending else (sort_expr.asc(), id_col.asc())
    rows = list(db.scalars(stmt.order_by(*order).limit(limit + 1)))
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        last_sort = getattr(last, sort_col.key)
        next_cursor = encode_cursor(null_as if last_sort is None else last_sort, getattr(last, id_col.key))
    return rows, next_cursor
