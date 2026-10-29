#!/usr/bin/env bash
# Backs up the deployed Corral's state (D12, D14): a Postgres dump and the
# server's blob folder. Run nightly from a timer, and by auto-deploy.sh before
# a deploy that brings new migrations. Run it from the checkout that docker
# compose runs from, as the user who owns it. See scripts/deploy/README.md.
#
# Usage: backup.sh [label]   (the label goes in the file names; default "nightly")
set -euo pipefail

cd "$(dirname "$0")/../.."

label=${1:-nightly}
backup_dir=${CORRAL_BACKUP_DIR:-.corral/backups}
keep_days=${CORRAL_BACKUP_KEEP_DAYS:-14}
# The commit running now, so a restore can check out code that matches the
# schema. Not HEAD: a deploy checks out the new commit before it backs up.
running=$(cat .corral/deploy/deployed 2>/dev/null || git rev-parse HEAD)
stamp=$(date +%Y%m%d-%H%M%S)-${running:0:7}
mkdir -p "$backup_dir"

log() { echo "$(date +%Y-%m-%dT%H:%M:%S%z) $*"; }

# Write to a temporary name first, so a failed dump never looks like a backup
db="$backup_dir/postgres-$stamp-$label.dump"
docker compose exec -T postgres pg_dump -U corral -Fc corral >"$db.partial"
mv "$db.partial" "$db"

blobs="$backup_dir/server-data-$stamp-$label.tar.gz"
docker compose exec -T server tar -C /data/server -czf - . >"$blobs.partial"
mv "$blobs.partial" "$blobs"

log "backed up to $db and $blobs"

find "$backup_dir" -maxdepth 1 -type f \( -name 'postgres-*' -o -name 'server-data-*' \) -mtime "+$keep_days" -delete
