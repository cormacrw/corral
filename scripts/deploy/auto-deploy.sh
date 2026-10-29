#!/usr/bin/env bash
# Redeploys Corral on the home server when main moves (D12). Run it from a
# timer (see scripts/deploy/README.md) in the checkout that docker compose runs
# from. It pulls rather than being pushed to, so nothing new is exposed through
# the tunnel and GitHub holds no credentials for the server.
#
# Each tick: if origin/main differs from what was last deployed and the `ci`
# check on that commit passed, check it out and build the images while the
# old containers keep serving. If anything besides web would restart, put the
# server on its update hold (nothing new starts) and wait for running work to
# finish, so no agent run is cut off. Then `docker compose up -d`.
set -euo pipefail

cd "$(dirname "$0")/../.."

branch=${CORRAL_DEPLOY_BRANCH:-main}
state_dir=.corral/deploy
mkdir -p "$state_dir"

# One deploy at a time; a tick that overlaps a slow build or a wait just exits
exec 9>"$state_dir/lock"
flock -n 9 || exit 0

log() { echo "$(date +%Y-%m-%dT%H:%M:%S%z) $*"; }

# Calls the server API from inside its container; the API is never published
api() {
  docker compose exec -T server node -e "
    fetch('http://127.0.0.1:' + (process.env.CORRAL_SERVER_PORT || 4100) + '/api$2', { method: '$1' })
      .then(async r => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()) })
      .catch(() => process.exit(1))"
}

# Restarting web doesn't touch runs; restarting any other service might.
# Anything it can't tell counts as a change, so the safe answer wins.
needs_hold() {
  local services svc container want
  services=$(docker compose config --services) || return 0
  for svc in $services; do
    [ "$svc" = web ] && continue
    container=$(docker compose ps -q "$svc" 2>/dev/null || true)
    [ -n "$container" ] || continue
    [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")" \
      = "$(docker compose config --hash "$svc" | awk '{print $2}')" ] || return 0
    want=$(docker compose config --images "$svc")
    [ "$(docker inspect -f '{{.Image}}' "$container")" \
      = "$(docker image inspect -f '{{.Id}}' "$want" 2>/dev/null)" ] || return 0
  done
  return 1
}

release() { api DELETE /update-hold >/dev/null 2>&1 || true; }

# ls-remote doesn't count against the GitHub API rate limit, so polling is cheap
remote_sha=$(git ls-remote origin "refs/heads/$branch" | cut -f1)
[ -n "$remote_sha" ] || { log "could not read origin/$branch"; exit 1; }

deployed_sha=$(cat "$state_dir/deployed" 2>/dev/null || true)
skipped_sha=$(cat "$state_dir/skipped" 2>/dev/null || true)
[ "$remote_sha" = "$deployed_sha" ] && exit 0
[ "$remote_sha" = "$skipped_sha" ] && exit 0

# Only deploy commits whose CI passed. The repo is public, so no token is needed.
repo=$(git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
checks=$(curl -fsS "https://api.github.com/repos/$repo/commits/$remote_sha/check-runs?check_name=ci")
conclusions=$(grep -o '"conclusion": *"[a-z_]*"' <<<"$checks" | sed -E 's/.*"([a-z_]*)"$/\1/' || true)
statuses=$(grep -o '"status": *"[a-z_]*"' <<<"$checks" | sed -E 's/.*"([a-z_]*)"$/\1/' || true)

if ! grep -qx success <<<"$conclusions"; then
  if [ -z "$statuses" ] || grep -qvx completed <<<"$statuses"; then
    exit 0 # CI hasn't finished yet; try again next tick
  fi
  log "CI failed for $remote_sha; not deploying"
  echo "$remote_sha" >"$state_dir/skipped"
  exit 0
fi

log "building $remote_sha (deployed: ${deployed_sha:-nothing})"
git fetch --quiet origin "$branch"
# The deploy checkout has no local work; .env is untracked and survives this
git checkout --quiet --detach "$remote_sha"
if ! docker compose build; then
  log "build failed for $remote_sha; not deploying"
  echo "$remote_sha" >"$state_dir/skipped"
  exit 1
fi

if needs_hold; then
  # If the server can't be reached it isn't running anything worth waiting
  # for, and a broken server must not block the deploy that fixes it
  if api POST /update-hold >/dev/null 2>&1; then
    trap release EXIT
    trap 'exit 1' INT TERM
    log "holding new work until running work finishes"
    waited=0
    while busy=$(api POST /update-hold | sed -E 's/.*"busy":([0-9]+).*/\1/') && [ "$busy" != 0 ]; do
      [ $((waited % 300)) = 0 ] && log "waiting for $busy run(s) or merge(s) to finish"
      sleep 15
      waited=$((waited + 15))
    done
  else
    log "server not reachable; deploying without waiting"
  fi
fi

docker compose up -d --remove-orphans
# The new server starts without the hold
trap - EXIT
docker image prune -f >/dev/null
echo "$remote_sha" >"$state_dir/deployed"
log "deployed $remote_sha"
