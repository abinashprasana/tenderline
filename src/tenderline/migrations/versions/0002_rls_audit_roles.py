"""row level security, append-only triggers, app role and grants

Revision ID: 0002
Revises: 0001
"""

from alembic import op

from tenderline.config import get_settings
from tenderline.models import TENANT_TABLES

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

APP_ROLE = "tenderline_app"
ORG_EXPR = "NULLIF(current_setting('app.org_id', true), '')::uuid"


def upgrade() -> None:
    pw = get_settings().app_db_password.replace("'", "''")
    op.execute(
        f"""
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
            CREATE ROLE {APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '{pw}';
          ELSE
            ALTER ROLE {APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{pw}';
          END IF;
        END $$;
        """
    )
    op.execute(f"GRANT USAGE ON SCHEMA public TO {APP_ROLE}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {APP_ROLE}")
    op.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {APP_ROLE}")
    # History is never rewritten: the app role may only read and append.
    op.execute(f"REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, notice_versions FROM {APP_ROLE}")
    op.execute(f"REVOKE ALL ON alembic_version FROM {APP_ROLE}")

    # Row level security on every tenant-owned table. The table owner (migrations, tests, seed) bypasses
    # RLS by design; the app role never does.
    for table in TENANT_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} "
            f"USING (organisation_id = {ORG_EXPR}) WITH CHECK (organisation_id = {ORG_EXPR})"
        )
    op.execute("ALTER TABLE organisations ENABLE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY tenant_isolation ON organisations "
        f"USING (id = {ORG_EXPR}) WITH CHECK (id = {ORG_EXPR})"
    )

    # Append-only enforcement: reject UPDATE and DELETE even for the owner role.
    op.execute(
        """
        CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
        END $$;
        """
    )
    for table in ("audit_log", "notice_versions"):
        op.execute(
            f"CREATE TRIGGER {table}_append_only BEFORE UPDATE OR DELETE ON {table} "
            f"FOR EACH ROW EXECUTE FUNCTION reject_mutation()"
        )
        op.execute(
            f"CREATE TRIGGER {table}_no_truncate BEFORE TRUNCATE ON {table} "
            f"FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()"
        )

    # Narrow SECURITY DEFINER helpers for the few legitimately cross-tenant lookups. They run as the
    # table owner, return only ids/roles, and are the only way around RLS.
    op.execute(
        """
        CREATE FUNCTION app_list_org_ids() RETURNS TABLE(org_id uuid)
        LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT id FROM organisations $$;
        """
    )
    op.execute(
        """
        CREATE FUNCTION app_membership_role(p_user uuid, p_org uuid) RETURNS text
        LANGUAGE sql SECURITY DEFINER SET search_path = public AS
        $$ SELECT role FROM memberships WHERE user_id = p_user AND organisation_id = p_org $$;
        """
    )
    op.execute(
        """
        CREATE FUNCTION app_user_memberships(p_user uuid) RETURNS TABLE(org_id uuid, role text)
        LANGUAGE sql SECURITY DEFINER SET search_path = public AS
        $$ SELECT organisation_id, role::text FROM memberships WHERE user_id = p_user $$;
        """
    )
    op.execute(
        """
        CREATE FUNCTION app_orgs_for_notice(p_notice uuid) RETURNS TABLE(org_id uuid)
        LANGUAGE sql SECURITY DEFINER SET search_path = public AS
        $$ SELECT organisation_id FROM matches WHERE notice_id = p_notice
           UNION SELECT organisation_id FROM opportunities WHERE notice_id = p_notice $$;
        """
    )
    for fn in (
        "app_list_org_ids()",
        "app_membership_role(uuid, uuid)",
        "app_user_memberships(uuid)",
        "app_orgs_for_notice(uuid)",
    ):
        op.execute(f"REVOKE ALL ON FUNCTION {fn} FROM PUBLIC")
        op.execute(f"GRANT EXECUTE ON FUNCTION {fn} TO {APP_ROLE}")


def downgrade() -> None:
    for fn in (
        "app_orgs_for_notice(uuid)",
        "app_user_memberships(uuid)",
        "app_membership_role(uuid, uuid)",
        "app_list_org_ids()",
    ):
        op.execute(f"DROP FUNCTION IF EXISTS {fn}")
    for table in ("audit_log", "notice_versions"):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_append_only ON {table}")
        op.execute(f"DROP TRIGGER IF EXISTS {table}_no_truncate ON {table}")
    op.execute("DROP FUNCTION IF EXISTS reject_mutation()")
    for table in [*TENANT_TABLES, "organisations"]:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
