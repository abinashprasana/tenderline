import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, ProgrammingError

from tenderline.db import owner_session, tenant_session


def _insert_search(s, org_id, name="s"):
    s.execute(
        text("INSERT INTO saved_searches (organisation_id, name) VALUES (:o, :n)"), {"o": org_id, "n": name}
    )


def test_app_role_is_not_superuser_and_cannot_bypass_rls(migrated_db):
    with owner_session() as s:
        row = s.execute(
            text("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='tenderline_app'")
        ).one()
    assert row == (False, False)


def test_rls_hides_other_tenants_rows(make_org):
    a, b = make_org("Tenant A"), make_org("Tenant B")
    with tenant_session(a["org_id"]) as s:
        _insert_search(s, a["org_id"], "a-search")
    with tenant_session(b["org_id"]) as s:
        _insert_search(s, b["org_id"], "b-search")
        names = [r[0] for r in s.execute(text("SELECT name FROM saved_searches"))]
    assert names == ["b-search"]


def test_rls_blocks_writing_into_another_tenant(make_org):
    a, b = make_org("Tenant A"), make_org("Tenant B")
    with pytest.raises((DBAPIError, ProgrammingError)), tenant_session(a["org_id"]) as s:
        _insert_search(s, b["org_id"])


def test_no_tenant_context_means_no_rows(make_org):
    a = make_org("Tenant A")
    with tenant_session(a["org_id"]) as s:
        _insert_search(s, a["org_id"])
    from tenderline.db import public_session

    with public_session() as s:
        assert s.execute(text("SELECT count(*) FROM saved_searches")).scalar() == 0


def test_tenant_context_does_not_leak_across_pooled_connections(make_org):
    a, b = make_org("Tenant A"), make_org("Tenant B")
    with tenant_session(a["org_id"]) as s:
        _insert_search(s, a["org_id"])
    for _ in range(20):
        with tenant_session(b["org_id"]) as s:
            assert s.execute(text("SELECT count(*) FROM saved_searches")).scalar() == 0


def _audit(s, org_id):
    s.execute(
        text(
            "INSERT INTO audit_log (organisation_id, actor_type, actor_id, action, entity_type, entity_id)"
            " VALUES (:o,'human','u1','test.action','thing','1')"
        ),
        {"o": org_id},
    )


def test_audit_log_rejects_update_and_delete_even_for_owner(make_org):
    a = make_org()
    with owner_session() as s:
        _audit(s, a["org_id"])
    with pytest.raises((DBAPIError, ProgrammingError)), owner_session() as s:
        s.execute(text("UPDATE audit_log SET action='tampered'"))
    with pytest.raises((DBAPIError, ProgrammingError)), owner_session() as s:
        s.execute(text("DELETE FROM audit_log"))
    with pytest.raises((DBAPIError, ProgrammingError)), owner_session() as s:
        s.execute(text("TRUNCATE audit_log"))


def test_audit_log_app_role_can_append_but_not_modify(make_org):
    a = make_org()
    with tenant_session(a["org_id"]) as s:
        _audit(s, a["org_id"])
    with pytest.raises((DBAPIError, ProgrammingError)), tenant_session(a["org_id"]) as s:
        s.execute(text("UPDATE audit_log SET action='x'"))


def test_notice_versions_are_append_only(migrated_db):
    nid = uuid.uuid4()
    with owner_session() as s:
        s.execute(
            text(
                "INSERT INTO notices (id, source, source_id, notice_type, title, current_version, status) VALUES (:i,'ted','1-2026','cn','t',1,'open')"
            ),
            {"i": nid},
        )
        s.execute(
            text(
                "INSERT INTO notice_versions (notice_id, version, content_hash, raw, fields)"
                " VALUES (:i, 1, 'h', '{}', '{}')"
            ),
            {"i": nid},
        )
    with pytest.raises((DBAPIError, ProgrammingError)), owner_session() as s:
        s.execute(text("UPDATE notice_versions SET content_hash='z'"))


def test_every_tenant_table_has_rls_enabled(migrated_db):
    from tenderline.models import TENANT_TABLES

    with owner_session() as s:
        rows = dict(
            s.execute(
                text("SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY(:t)"),
                {"t": [*TENANT_TABLES, "organisations"]},
            ).all()
        )
    assert rows and all(rows.values()), rows
