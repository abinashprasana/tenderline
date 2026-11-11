"""database-level defaults for status/counter columns; reconciler lookup function

Defaults previously lived only in the ORM, so raw SQL, seed scripts and other writers could insert NULLs or
fail. This is a backwards-compatible change (setting defaults never breaks existing writers).

Revision ID: 0004
Revises: 0003
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

DEFAULTS = [
    ("notices", "current_version", "1"),
    ("notices", "status", "'open'"),
    ("ingestion_runs", "status", "'running'"),
    ("ingestion_runs", "notices_seen", "0"),
    ("ingestion_runs", "notices_new", "0"),
    ("ingestion_runs", "notices_updated", "0"),
    ("opportunities", "status", "'new'"),
    ("deadlines", "source", "'human'"),
    ("agent_proposals", "status", "'pending'"),
    ("llm_calls", "input_tokens", "0"),
    ("llm_calls", "output_tokens", "0"),
    ("llm_calls", "latency_ms", "0"),
    ("llm_calls", "cost_usd", "0"),
    ("llm_calls", "status", "'ok'"),
    ("notice_cpv", "is_main", "false"),
]


def upgrade() -> None:
    for table, column, default in DEFAULTS:
        op.execute(f"ALTER TABLE {table} ALTER COLUMN {column} SET DEFAULT {default}")
    # Cross-tenant lookup for the reconciler: approvals whose execution workflow may never have started
    # (process died between commit and start). Returns ids only.
    op.execute(
        """
        CREATE FUNCTION app_stale_approved_proposals(p_older_than interval) RETURNS TABLE(org_id uuid, proposal_id uuid)
        LANGUAGE sql SECURITY DEFINER SET search_path = public AS
        $$ SELECT organisation_id, id FROM agent_proposals
           WHERE status = 'approved' AND decided_at < now() - p_older_than $$;
        """
    )
    op.execute("REVOKE ALL ON FUNCTION app_stale_approved_proposals(interval) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION app_stale_approved_proposals(interval) TO tenderline_app")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS app_stale_approved_proposals(interval)")
    for table, column, _ in DEFAULTS:
        op.execute(f"ALTER TABLE {table} ALTER COLUMN {column} DROP DEFAULT")
