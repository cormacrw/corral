#!/usr/bin/env bash
# Backs up the deployed Corral's state (D12, D14): a Postgres dump and the
# server's blob folder. Run nightly from a timer, and by auto-deploy.sh before
# a deploy that brings new migrations. Run it from the checkout that docker
# compose runs from, as the user who owns it. See scripts/deploy/README.md.
#
# Usage: backup.sh [label]   (the label goes in the file names; default "nightly")
#
# Holds the deploy lock, so it never runs while a deploy restarts the containers
# it reads. It refuses to start with less than CORRAL_BACKUP_MIN_FREE_MB free,
# because a full disk takes Postgres down with it.
set -euo pipefail

cd "$(dirname "$0")/../.."

label=${1:-nightly}
backup_dir=${CORRAL_BACKUP_DIR:-.corral/backups}
keep_days=${CORRAL_BACKUP_KEEP_DAYS:-14}
mkdir -p "$backup_dir" .corral/deploy

log() { echo "$(date +%Y-%m-%dT%H:%M:%S%z) $*"; }

# auto-deploy.sh already holds the lock when it calls this. A deploy can wait
# an hour on running work, so the nightly run waits it out rather than failing.
if [ "${CORRAL_DEPLOY_LOCK_HELD:-}" != 1 ]; then
  exec 9>.corral/deploy/lock
  flock -w "${CORRAL_BACKUP_LOCK_WAIT:-7200}" 9 || { log "a deploy held the lock too long; not backing up"; exit 1; }
fi

# The commit running now, so a restore can check out code that matches the
# schema. Not HEAD: a deploy checks out the new commit before it backs up.
running=$(cat .corral/deploy/deployed 2>/dev/null || git rev-parse HEAD)
stamp=$(date +%Y%m%d-%H%M%S)-${running:0:7}

# Left behind by a run that was killed; nothing else can be writing now
rm -f "$backup_dir"/*.partial

min_free_mb=${CORRAL_BACKUP_MIN_FREE_MB:-2048}
free_mb=$(df -Pk "$backup_dir" | awk 'NR == 2 { print int($4 / 1024) }')
if [ "$free_mb" -lt "$min_free_mb" ]; then
  log "only ${free_mb} MB free in $backup_dir, need ${min_free_mb} MB; not backing up"
  exit 1
fi

# Write to a temporary name first, so a failed dump never looks like a backup
db="$backup_dir/postgres-$stamp-$label.dump"
blobs="$backup_dir/server-data-$stamp-$label.tar.gz"
trap 'rm -f "$db.partial" "$blobs.partial"' EXIT
trap 'exit 1' INT TERM

docker compose exec -T postgres pg_dump -U corral -Fc corral >"$db.partial"
mv "$db.partial" "$db"

# A one-off container, not `exec server`: a broken or stopped server must not
# stop the backup in front of the deploy that fixes it. --name so it can't
# clash with the service's container_name.
status=0
docker compose run --rm --no-deps -T --name "corral-backup-$$" --entrypoint tar server \
  -C /data/server -czf - . >"$blobs.partial" || status=$?
# Tar exits 1 when a file changes while it is read, as transcripts do with runs
# active, and the archive is still good. Compose exits 1 for its own failures
# too, so only a readable archive counts.
if [ "$status" -gt 1 ] || ! gzip -t "$blobs.partial" 2>/dev/null; then
  log "backing up blobs failed (exit $status)"
  exit 1
fi
[ "$status" = 0 ] || log "warning: files changed during the blob backup; they may be incomplete in it"
mv "$blobs.partial" "$blobs"

log "backed up to $db and $blobs"

find "$backup_dir" -maxdepth 1 -type f \( -name 'postgres-*' -o -name 'server-data-*' \) -mtime "+$keep_days" -delete
