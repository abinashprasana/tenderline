from alembic import context
from sqlalchemy import create_engine

from tenderline.config import get_settings
from tenderline.models import Base

config = context.config
target_metadata = Base.metadata


def run_migrations_online() -> None:
    # Migrations always run as the table owner, never as the RLS-subject app role.
    engine = create_engine(get_settings().database_url)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
