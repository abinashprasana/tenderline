#!/usr/bin/env bash
# Nightly logical backup of both databases (app data and DBOS workflow state), with retention and optional
# upload to OCI Object Storage through its S3-compatible API. Run by the `backup` service in
# docker-compose.prod.yml, or by hand:  docker compose -f docker-compose.prod.yml exec backup backup.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

for db in tenderline tenderline_dbos; do
  out="$BACKUP_DIR/${db}-${STAMP}.dump"
  pg_dump --format=custom --no-owner --dbname="$db" --file="$out"
  pg_restore --list "$out" >/dev/null   # fail loudly if the archive is unreadable
  echo "backup ok: $out ($(du -h "$out" | cut -f1))"
  if [ -n "${OCI_S3_BUCKET:-}" ] && [ -n "${OCI_S3_ENDPOINT:-}" ]; then
    aws s3 cp "$out" "s3://${OCI_S3_BUCKET}/$(basename "$out")" --endpoint-url "$OCI_S3_ENDPOINT"
  fi
done

find "$BACKUP_DIR" -name '*.dump' -mtime +"$RETENTION" -delete
