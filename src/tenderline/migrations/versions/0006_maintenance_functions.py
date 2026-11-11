"""functions for the maintenance workflows

Both run as the table owner and are the only cross-tenant access these jobs have: one lists open
opportunities (ids only), the other deletes expired idempotency keys.

Revision ID: 0006
Revises: 0005
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

FUNCTIONS = ("app_open_opportunities(interval)", "app_purge_idempotency_keys(interval)")


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION app_open_opportunities(p_older_than interval)
        RETURNS TABLE(org_id uuid, opportunity_id uuid, workflow_id text)
        LANGUAGE sql SECURITY DEFINER SET search_path = public AS
        $$ SELECT organisation_id, id, workflow_id::text FROM opportunities
           WHERE closed_at IS NULL AND status NOT IN ('no_bid', 'won', 'lost')
             AND created_at < now() - p_older_than $$;
        """
    )
    op.execute(
        """
        CREATE FUNCTION app_purge_idempotency_keys(p_older_than interval) RETURNS integer
        LANGUAGE sql SECURITY DEFINER SET search_path = public AS
        $$ WITH deleted AS (
               DELETE FROM idempotency_keys WHERE created_at < now() - p_older_than RETURNING 1)
           SELECT count(*)::integer FROM deleted $$;
        """
    )
    for function in FUNCTIONS:
        op.execute(f"REVOKE ALL ON FUNCTION {function} FROM PUBLIC")
        op.execute(f"GRANT EXECUTE ON FUNCTION {function} TO tenderline_app")


def downgrade() -> None:
    for function in FUNCTIONS:
        op.execute(f"DROP FUNCTION IF EXISTS {function}")
