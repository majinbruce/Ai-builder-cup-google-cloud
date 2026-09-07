#!/usr/bin/env bash
#
# Nightly logical backup of every project database on this box.
#
# Projects are DISCOVERED, not listed. Each project's compose.prod.yml labels
# its postgres service `backup.enable=true` and `backup.project=<slug>`, so a
# new project is backed up from its first `up -d` with no edit here. The
# alternative — a list in this file — fails in exactly one way, silently, for
# the project you added last and forgot about.
#
#   Install: see deploy/README.md
#   Run:     /srv/edge/backup/pg-backup.sh
#
set -Eeuo pipefail

# Every file this script creates is a full logical copy of a production
# database — user emails, password hashes, session tokens. Owner-only, always;
# the default umask would leave them world-readable in /var/backups.
umask 077

CONFIG_FILE="${PG_BACKUP_CONFIG:-/etc/pg-backup.env}"
# shellcheck source=/dev/null
[[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/postgres}"
LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-14}"
REMOTE_RETENTION_DAYS="${REMOTE_RETENTION_DAYS:-90}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"           # e.g. b2:my-bucket/pg
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"       # https://hc-ping.com/<uuid>

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="$(mktemp)"
trap 'rm -f "$LOG_FILE"' EXIT

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG_FILE"; }

ping_hc() {
  # A dead-man's switch, and the reason this script is trustworthy rather than
  # merely present. Cron mails failures to a local mailbox nobody reads, and a
  # backup that stopped running produces NO output at all — which is
  # indistinguishable from success if you are only watching for errors.
  # healthchecks.io inverts it: it alerts when the nightly ping does not
  # arrive, so silence becomes the alarm instead of the reassurance.
  [[ -n "$HEALTHCHECK_URL" ]] || return 0
  curl -fsS -m 10 --retry 3 --data-binary @"${2:-/dev/null}" \
    "${HEALTHCHECK_URL}${1}" >/dev/null || true
}

fail() {
  log "FAILED: $*"
  ping_hc "/fail" "$LOG_FILE"
  exit 1
}
trap 'fail "unexpected error on line $LINENO"' ERR

ping_hc "/start"
log "backup run ${STAMP}"

mapfile -t CONTAINERS < <(
  docker ps --filter 'label=backup.enable=true' --format '{{.ID}} {{.Label "backup.project"}}'
)

# Zero projects is a FAILURE, never a quiet success. It means the labels are
# missing, Docker is down, or every stack is stopped — and "backed up nothing,
# reported OK" is the precise outcome this whole script exists to prevent.
[[ ${#CONTAINERS[@]} -gt 0 ]] || fail "no containers with label backup.enable=true"

for entry in "${CONTAINERS[@]}"; do
  cid="${entry%% *}"
  project="${entry#* }"

  [[ -n "$project" ]] || fail "container ${cid} has backup.enable but no backup.project label"

  # Credentials come from the container itself rather than from a copy kept
  # here, so rotating the database password cannot desynchronise the backup.
  db_user="$(docker exec "$cid" printenv POSTGRES_USER)"
  db_name="$(docker exec "$cid" printenv POSTGRES_DB)"

  dest_dir="${BACKUP_DIR}/${project}"
  mkdir -p "$dest_dir"
  dest="${dest_dir}/${project}-${STAMP}.dump"

  log "dumping ${project} (${db_name})"

  # -Fc is the custom format: compressed, and restorable selectively with
  # pg_restore (one table, or schema-only) rather than being a flat SQL file
  # you can only replay in full.
  #
  # --no-owner / --no-privileges because the restore target is a fresh
  # container whose role names need not match the ones in the dump — without
  # them a restore fails on every GRANT to a role that does not exist yet.
  #
  # pg_dump runs INSIDE the container, so the host needs no postgres client
  # tools and cannot be running a version older than the server (which
  # pg_dump refuses outright).
  docker exec "$cid" pg_dump -U "$db_user" -d "$db_name" \
    --format=custom --no-owner --no-privileges > "$dest" \
    || fail "pg_dump failed for ${project}"

  # A dump that exists is not a dump that restores. Reading the archive's table
  # of contents back is cheap and catches the failure that actually happens: a
  # truncated file from a disk that filled up mid-write, which has a perfectly
  # normal size and exit status until the day you need it.
  docker exec -i "$cid" pg_restore --list > /dev/null < "$dest" \
    || fail "dump for ${project} is not a readable archive"

  log "  ok: $(du -h "$dest" | cut -f1) -> ${dest}"
done

if [[ -n "$RCLONE_REMOTE" ]]; then
  log "syncing to ${RCLONE_REMOTE}"

  # `copy`, not `sync`. sync mirrors deletions, so a local prune — or a bug
  # that empties BACKUP_DIR — would propagate and delete the offsite copies
  # too, turning two independent failures into one. Remote retention is
  # handled separately below, on the remote's own clock.
  rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE" --transfers 2 --stats-one-line \
    || fail "rclone copy failed"

  rclone delete "$RCLONE_REMOTE" --min-age "${REMOTE_RETENTION_DAYS}d" --rmdirs \
    || log "  WARNING: remote retention pass failed (backups still uploaded)"
else
  log "RCLONE_REMOTE unset — local-only backup, this box is a single point of failure"
fi

# Local pruning runs LAST and only after the upload succeeded, so a failed
# sync never costs you the local copy as well.
find "$BACKUP_DIR" -name '*.dump' -type f -mtime "+${LOCAL_RETENTION_DAYS}" -delete
log "pruned local dumps older than ${LOCAL_RETENTION_DAYS} days"

log "done"
ping_hc "" "$LOG_FILE"
