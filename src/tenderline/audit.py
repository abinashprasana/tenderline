from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.orm import Session

from tenderline.models import AuditLog
from tenderline.observability import current_trace_id


def write_audit(
    db: Session,
    org_id: uuid.UUID,
    *,
    actor_type: str,
    actor_id: str,
    action: str,
    entity_type: str,
    entity_id: Any,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> None:
    db.add(
        AuditLog(
            organisation_id=org_id,
            actor_type=actor_type,
            actor_id=actor_id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            before=before,
            after=after,
            trace_id=current_trace_id(),
        )
    )
    db.flush()
