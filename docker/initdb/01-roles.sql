-- Local/dev bootstrap. Production creates the same roles via the migration (see migrations/versions/0001).
SELECT 'CREATE DATABASE tenderline_dbos OWNER tenderline'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tenderline_dbos')\gexec
