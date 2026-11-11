#!/usr/bin/env bash
# Restore a backup into a running Postgres. DESTRUCTIVE: replaces the target database contents.
#   scripts/restore.sh tenderline /backups/tenderline-20261111T020000Z.dump
# Stop the app first (`docker compose stop app`) so nothing writes during the restore.
set -euo pipefail

DB="${1:?usage: restore.sh <database> <dump-file>}"
FILE="${2:?usage: restore.sh <database> <dump-file>}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }

read -r -p "This will DROP and recreate '$DB'. Type the database name to continue: " confirm
[ "$confirm" = "$DB" ] || { echo "aborted"; exit 1; }

dropdb --if-exists --force "$DB"
createdb --owner="${PGUSER:-tenderline}" "$DB"
pg_restore --no-owner --role="${PGUSER:-tenderline}" --dbname="$DB" "$FILE"
echo "restored $DB from $FILE. Start the app again; it re-applies any newer migrations on boot."
