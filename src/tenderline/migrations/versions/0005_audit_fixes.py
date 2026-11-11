"""indexes and columns for the audit fixes

- expression indexes so a notice can be found by its eForms identifier (or by the identifier a change notice
  points at) without scanning notice_versions
- at most one pending proposal per organisation, notice version and action
- ingestion_runs.notices_skipped, deadlines.offset_days

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX ix_notice_versions_notice_identifier ON notice_versions ((fields ->> 'notice_identifier'))"
    )
    op.execute(
        "CREATE INDEX ix_notice_versions_changed_notice_identifier "
        "ON notice_versions ((fields ->> 'changed_notice_identifier'))"
    )
    op.add_column("ingestion_runs", sa.Column("notices_skipped", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("deadlines", sa.Column("offset_days", sa.Integer(), nullable=True))
    # Existing duplicates would block the unique index: keep the oldest pending proposal of each kind.
    op.execute(
        """
        UPDATE agent_proposals p SET status = 'cancelled'
        WHERE p.status = 'pending' AND EXISTS (
            SELECT 1 FROM agent_proposals older
            WHERE older.status = 'pending' AND older.organisation_id = p.organisation_id
              AND older.notice_id = p.notice_id AND older.notice_version = p.notice_version
              AND older.action_type = p.action_type
              AND (older.created_at, older.id) < (p.created_at, p.id))
        """
    )
    op.create_index(
        "uq_agent_proposals_pending_action",
        "agent_proposals",
        ["organisation_id", "notice_id", "notice_version", "action_type"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("uq_agent_proposals_pending_action", table_name="agent_proposals")
    op.drop_column("deadlines", "offset_days")
    op.drop_column("ingestion_runs", "notices_skipped")
    op.execute("DROP INDEX IF EXISTS ix_notice_versions_changed_notice_identifier")
    op.execute("DROP INDEX IF EXISTS ix_notice_versions_notice_identifier")
