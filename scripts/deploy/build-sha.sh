#!/usr/bin/env bash
# Prints the CORRAL_BUILD_SHA for a commit (default HEAD): the last commit that
# touched anything the server or runner images are built from, or that remote
# runners deploy from. A web-only or docs-only commit keeps the SHA, so the
# images stay identical, nothing behind the hold restarts (D16) and no runner
# counts as behind. A change this list misses is still deployed with a hold,
# because needs_hold compares images; only the SHA reported would lag.
set -euo pipefail

cd "$(dirname "$0")/../.."

commit=${1:-HEAD}
sha=$(git log -1 --format=%H "$commit" -- \
  apps/server apps/runner packages patches \
  pnpm-lock.yaml pnpm-workspace.yaml package.json \
  docker-compose.yml .dockerignore deploy/runner \
  scripts/deploy/runner-update.sh scripts/deploy/runner-update-io.py)
# No such commit in a shallow history: the commit itself is always a valid target
if [ -n "$sha" ]; then echo "$sha"; else git rev-parse "$commit"; fi
