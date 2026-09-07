#!/usr/bin/env bash
#
# Restore one project's database from a dump made by pg-backup.sh.
#
#   ./pg-restore.sh proj1                     # newest local dump for proj1
#   ./pg-restore.sh proj1 /path/to/file.dump  # a specific one
#
# This script exists because an untested backup is a hope, not a backup. Run it
# against a scratch project once, now, while nothing is on fire — the failure
# modes you want to discover today are "the dump was never actually readable"
# and "I do not know the syntax", not "production is down and I am reading
# pg_restore's man page".
#
set -Eeuo pipefail

CONFIG_FILE="${PG_BACKUP_CONFIG:-/etc/pg-backup.env}"
# shellcheck source=/dev/null
[[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/postgres}"

project="${1:-}"
dump="${2:-}"

[[ -n "$project" ]] || { echo "usage: $0 <project-slug> [dump-file]" >&2; exit 2; }

if [[ -z "$dump" ]]; then
  # Newest first. The timestamp in the filename is UTC and lexically sortable,
  # which is the entire reason it is formatted that way.
  dump="$(find "${BACKUP_DIR}/${project}" -name '*.dump' -type f 2>/dev/null | sort | tail -1)"
  [[ -n "$dump" ]] || { echo "no dumps found in ${BACKUP_DIR}/${project}" >&2; exit 1; }
fi

[[ -f "$dump" ]] || { echo "not a file: ${dump}" >&2; exit 1; }

cid="$(docker ps --filter "label=backup.project=${project}" --format '{{.ID}}' | head -1)"
[[ -n "$cid" ]] || { echo "no running postgres container labelled backup.project=${project}" >&2; exit 1; }

db_user="$(docker exec "$cid" printenv POSTGRES_USER)"
db_name="$(docker exec "$cid" printenv POSTGRES_DB)"

cat <<INFO

  project   ${project}
  database  ${db_name} (container ${cid})
  dump      ${dump}
            $(du -h "$dump" | cut -f1), $(date -u -r "$dump" +%Y-%m-%dT%H:%M:%SZ)

  This DROPS and recreates every object in ${db_name} before reloading.
  Anything written since the dump was taken is gone.

  Stop the api first so nothing writes underneath the restore:
      docker compose -f compose.prod.yml stop api

INFO

read -r -p "Type the project slug to confirm: " confirm
[[ "$confirm" == "$project" ]] || { echo "aborted"; exit 1; }

# --single-transaction is what makes this safe to attempt: the restore either
# completes or leaves the database exactly as it was. Without it a restore that
# fails halfway leaves you with neither the old data nor the new — which is a
# worse position than the one you started in.
docker exec -i "$cid" pg_restore \
  -U "$db_user" -d "$db_name" \
  --clean --if-exists --no-owner --no-privileges --single-transaction \
  < "$dump"

echo
echo "Restored ${project} from $(basename "$dump")."
echo "Start the api again:  docker compose -f compose.prod.yml start api"
