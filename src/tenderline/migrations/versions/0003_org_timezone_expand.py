"""expand: add organisations.timezone (backwards compatible)

Worked example of the expand/contract pattern, see docs/migrations.md. This is the EXPAND step only:
the column is nullable with a server default, so the previous app version (which neither reads nor
writes it) keeps working against the new schema, and a rollback of the app needs no schema change.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "organisations",
        sa.Column("timezone", sa.String(64), nullable=True, server_default="Europe/Dublin"),
    )


def downgrade() -> None:
    op.drop_column("organisations", "timezone")
