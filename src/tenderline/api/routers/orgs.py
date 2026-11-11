from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, text

from tenderline.api.deps import ROLES, CanRead, IdempotencyKeyHeader, IsAdmin, UserId, run_idempotent
from tenderline.audit import write_audit
from tenderline.db import public_session, tenant_session
from tenderline.errors import ApiError, conflict, not_found
from tenderline.models import Membership, Organisation, User

router = APIRouter(prefix="/v1/organisations", tags=["organisations"])

_NS = uuid.UUID("6f1d0b2e-3c5a-4d7e-9a11-0c9e5b7a1f42")


class OrgProfile(BaseModel):
    """What the qualification agent is told about the company."""

    description: str = Field(default="", max_length=2000)
    capabilities: list[str] = Field(default_factory=list, max_length=50)
    regions: list[str] = Field(default_factory=list, max_length=50)
    certifications: list[str] = Field(default_factory=list, max_length=50)
    min_contract_value: float | None = None
    max_contract_value: float | None = None


class OrgCreate(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    profile: OrgProfile = Field(default_factory=OrgProfile)


class OrgPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    profile: OrgProfile | None = None
    timezone: str | None = Field(default=None, max_length=64)


class OrgOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    slug: str
    profile: dict[str, Any]
    timezone: str | None
    created_at: datetime


class MemberIn(BaseModel):
    login: str = Field(min_length=1, max_length=100)
    role: str


class RolePatch(BaseModel):
    role: str


class MemberOut(BaseModel):
    user_id: uuid.UUID
    login: str
    name: str | None
    role: str


class MyOrgOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    role: str


def _check_role(role: str) -> None:
    if role not in ROLES:
        raise ApiError(422, "invalid_role", f"role must be one of {list(ROLES)}")


@router.post("", status_code=201, response_model=OrgOut, summary="Create an organisation (caller becomes owner)")
def create_org(payload: OrgCreate, user_id: UserId, key: IdempotencyKeyHeader) -> JSONResponse:
    # The organisation id is derived from (user, idempotency key): a retry maps to the same row.
    org_id = uuid.uuid5(_NS, f"{user_id}:{key}")
    slug = f"{re.sub(r'[^a-z0-9]+', '-', payload.name.lower()).strip('-')[:60]}-{org_id.hex[:6]}"
    with tenant_session(org_id) as db:
        existing = db.get(Organisation, org_id)
        if existing is not None:
            return JSONResponse(
                OrgOut.model_validate(existing).model_dump(mode="json"),
                200,
                headers={"Idempotent-Replay": "true"},
            )
        org = Organisation(id=org_id, name=payload.name, slug=slug, profile=payload.profile.model_dump())
        db.add(org)
        db.flush()
        db.add(Membership(organisation_id=org_id, user_id=user_id, role="owner"))
        write_audit(
            db,
            org_id,
            actor_type="human",
            actor_id=str(user_id),
            action="organisation.created",
            entity_type="organisation",
            entity_id=org_id,
            after={"name": payload.name},
        )
        db.refresh(org)
        return JSONResponse(OrgOut.model_validate(org).model_dump(mode="json"), 201)


@router.get("", response_model=list[MyOrgOut], summary="Organisations I belong to, with my role")
def list_my_orgs(user_id: UserId) -> list[MyOrgOut]:
    with public_session() as db:
        memberships = db.execute(text("SELECT org_id, role FROM app_user_memberships(:u)"), {"u": user_id}).all()
    result = []
    for org_id, role in memberships:
        # Row-level security only shows an organisation inside its own tenant transaction.
        with tenant_session(org_id) as db:
            org = db.get(Organisation, org_id)
            if org is not None:
                result.append(MyOrgOut(id=org.id, name=org.name, slug=org.slug, role=role))
    return sorted(result, key=lambda o: o.name.lower())


@router.get("/{org_id}", response_model=OrgOut)
def get_org(org_id: uuid.UUID, ctx: CanRead) -> Organisation:
    org = ctx.db.get(Organisation, org_id)
    if org is None:
        raise not_found("Organisation")
    return org


@router.patch("/{org_id}", response_model=OrgOut, summary="Update name, profile or timezone (owner)")
def patch_org(org_id: uuid.UUID, payload: OrgPatch, ctx: IsAdmin) -> Organisation:
    org = ctx.db.get(Organisation, org_id)
    if org is None:
        raise not_found("Organisation")
    before = {"name": org.name, "profile": org.profile, "timezone": org.timezone}
    if payload.name is not None:
        org.name = payload.name
    if payload.profile is not None:
        org.profile = payload.profile.model_dump()
    if payload.timezone is not None:
        org.timezone = payload.timezone
    ctx.db.flush()
    write_audit(
        ctx.db,
        ctx.org_id,
        actor_type="human",
        actor_id=str(ctx.user_id),
        action="organisation.updated",
        entity_type="organisation",
        entity_id=org_id,
        before=before,
        after={"name": org.name, "profile": org.profile, "timezone": org.timezone},
    )
    return org


@router.get("/{org_id}/members", response_model=list[MemberOut])
def list_members(org_id: uuid.UUID, ctx: CanRead) -> list[MemberOut]:
    rows = ctx.db.execute(
        select(Membership.user_id, User.login, User.name, Membership.role)
        .join(User, User.id == Membership.user_id)
        .order_by(User.login)
    ).all()
    return [MemberOut(user_id=r[0], login=r[1], name=r[2], role=r[3]) for r in rows]


@router.post(
    "/{org_id}/members",
    status_code=201,
    response_model=MemberOut,
    summary="Add an existing user (one who has logged in) by login (owner)",
)
def add_member(org_id: uuid.UUID, payload: MemberIn, ctx: IsAdmin, key: IdempotencyKeyHeader) -> JSONResponse:
    _check_role(payload.role)

    def run() -> tuple[int, Any]:
        user = ctx.db.scalars(select(User).where(User.login == payload.login)).first()
        if user is None:
            raise not_found("User (they must log in once first)")
        if ctx.db.scalars(select(Membership).where(Membership.user_id == user.id)).first():
            raise conflict("already_member", "User is already a member of this organisation")
        ctx.db.add(Membership(organisation_id=org_id, user_id=user.id, role=payload.role))
        write_audit(
            ctx.db,
            org_id,
            actor_type="human",
            actor_id=str(ctx.user_id),
            action="membership.added",
            entity_type="membership",
            entity_id=user.id,
            after={"role": payload.role},
        )
        return 201, MemberOut(user_id=user.id, login=user.login, name=user.name, role=payload.role)

    return run_idempotent(ctx.db, org_id, key, payload, run)


@router.patch("/{org_id}/members/{user_id}", response_model=MemberOut, summary="Change a member's role (owner)")
def change_role(org_id: uuid.UUID, user_id: uuid.UUID, payload: RolePatch, ctx: IsAdmin) -> MemberOut:
    _check_role(payload.role)
    m = ctx.db.scalars(select(Membership).where(Membership.user_id == user_id)).first()
    if m is None:
        raise not_found("Member")
    if m.role == "owner" and payload.role != "owner" and _owner_count(ctx) <= 1:
        raise conflict("last_owner", "An organisation must keep at least one owner")
    before, m.role = m.role, payload.role
    ctx.db.flush()
    write_audit(
        ctx.db,
        org_id,
        actor_type="human",
        actor_id=str(ctx.user_id),
        action="membership.role_changed",
        entity_type="membership",
        entity_id=user_id,
        before={"role": before},
        after={"role": payload.role},
    )
    user = ctx.db.get(User, user_id)
    assert user is not None
    return MemberOut(user_id=user.id, login=user.login, name=user.name, role=m.role)


@router.delete("/{org_id}/members/{user_id}", status_code=204, summary="Remove a member (owner)")
def remove_member(org_id: uuid.UUID, user_id: uuid.UUID, ctx: IsAdmin) -> None:
    m = ctx.db.scalars(select(Membership).where(Membership.user_id == user_id)).first()
    if m is None:
        raise not_found("Member")
    if m.role == "owner" and _owner_count(ctx) <= 1:
        raise conflict("last_owner", "An organisation must keep at least one owner")
    ctx.db.delete(m)
    write_audit(
        ctx.db,
        org_id,
        actor_type="human",
        actor_id=str(ctx.user_id),
        action="membership.removed",
        entity_type="membership",
        entity_id=user_id,
        before={"role": m.role},
    )


def _owner_count(ctx: Any) -> int:
    return int(ctx.db.scalar(select(func.count()).select_from(Membership).where(Membership.role == "owner")) or 0)
