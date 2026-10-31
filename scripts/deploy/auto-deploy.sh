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
# finish, so no agent run is cut off. Then `docker compose up -d --wait`; the
# commit only counts as deployed once the new containers are healthy.
set -euo pipefail

cd "$(dirname "$0")/../.."

branch=${CORRAL_DEPLOY_BRANCH:-main}
state_dir=.corral/deploy
mkdir -p "$state_dir"

# One deploy at a time; a tick that overlaps a slow build or a wait just exits
exec 9>"$state_dir/lock"
flock -n 9 || exit 0

log() { echo "$(date +%Y-%m-%dT%H:%M:%S%z) $*"; }

# Git silently ignores a repo owned by another user for commands like
# ls-remote, which then fail confusingly; rev-parse says why
git rev-parse --git-dir >/dev/null || { log "git can't use this checkout; run the service as the user who owns it (User= in the unit)"; exit 1; }

# Calls the server API from inside its container; the API is never published.
# An optional third argument is sent as the JSON body. It goes through stdin,
# because a long commit list would pass Linux's 128 KiB limit on one argument.
api() {
  printf '%s' "${3:-}" | docker compose exec -T server node -e "
    let body = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => { body += d })
    process.stdin.on('end', () => fetch('http://127.0.0.1:' + (process.env.CORRAL_SERVER_PORT || 4100) + '/api$2', {
      method: '$1',
      ...(body && { body, headers: { 'content-type': 'application/json' } }),
      signal: AbortSignal.timeout(30000)
    })
      .then(async r => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()) })
      .catch(() => process.exit(1)))"
}

# A JSON string. Commit subjects are one line, so only quotes, backslashes
# and control characters need escaping.
json_string() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$(tr -d '\000-\037' <<<"$s")"
}

# Tells the new server what this deploy shipped (POST /api/deployments), so
# the PM can write release notes. Every commit since the last deploy, or
# just the new one when nothing was deployed before (or that commit is gone).
report_deployment() {
  local log_lines line commits='' from=null tries=0
  if [ -z "$deployed_sha" ] || ! log_lines=$(git log --format='%H %s' "$deployed_sha..$remote_sha" 2>/dev/null); then
    log_lines=$(git log -1 --format='%H %s' "$remote_sha")
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    commits+="${commits:+,}{\"sha\":\"${line%% *}\",\"subject\":$(json_string "${line#* }")}"
  done <<<"$log_lines"
  if [ -n "$deployed_sha" ]; then from="\"$deployed_sha\""; fi
  # The new server runs its migrations before it answers
  until api GET /health >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt "${CORRAL_DEPLOY_REPORT_TRIES:-30}" ] || return 1
    sleep "${CORRAL_DEPLOY_REPORT_WAIT:-5}"
  done
  api POST /deployments "{\"repository\":$(json_string "$repo"),\"fromSha\":$from,\"toSha\":\"$remote_sha\",\"commits\":[$commits]}" >/dev/null
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

# Waits for running work to finish. Polling is what proves the server is alive,
# so a failed poll or an answer without a count isn't "nothing running". Several
# in a row mean the server is broken, and a broken server must not block the deploy.
wait_for_idle() {
  local response busy='' failures=0 waited=0
  while :; do
    busy=''
    if response=$(api POST /update-hold 2>/dev/null); then
      busy=$(sed -nE 's/.*"busy":([0-9]+).*/\1/p' <<<"$response")
    fi
    if [[ $busy =~ ^[0-9]+$ ]]; then
      failures=0
      [ "$busy" != 0 ] || return 0
      [ $((waited % 300)) != 0 ] || log "waiting for $busy run(s) or merge(s) to finish"
    else
      failures=$((failures + 1))
      if [ "$failures" -ge "${CORRAL_DEPLOY_HOLD_FAILURES:-8}" ]; then
        log "server stopped answering; deploying without waiting"
        return 0
      fi
    fi
    sleep "${CORRAL_DEPLOY_HOLD_WAIT:-15}"
    waited=$((waited + 15))
  done
}

# Tags what is running as :previous, so a bad deploy can be rolled back by hand
# without a rebuild. The prune below only removes untagged images. A retry of a
# failed deploy is already running its target, and that must not replace the
# good image.
keep_previous_images() {
  local svc container running want
  for svc in server runner web; do
    container=$(docker compose ps -q "$svc" 2>/dev/null || true)
    [ -n "$container" ] || continue
    running=$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)
    want=$(docker compose config --images "$svc" 2>/dev/null || true)
    [ -n "$running" ] && [ -n "$want" ] || continue
    [ "$running" != "$(docker image inspect -f '{{.Id}}' "$want" 2>/dev/null)" ] || continue
    docker image tag "$running" "${want%:*}:previous" || true
  done
}

# ls-remote doesn't count against the GitHub API rate limit, so polling is cheap
remote_sha=$(git ls-remote origin "refs/heads/$branch" | cut -f1)
[ -n "$remote_sha" ] || { log "could not read origin/$branch"; exit 1; }

deployed_sha=$(cat "$state_dir/deployed" 2>/dev/null || true)
skipped_sha=$(cat "$state_dir/skipped" 2>/dev/null || true)
[ "$remote_sha" = "$deployed_sha" ] && exit 0

# Only deploy commits whose CI passed. The repo is public, so no token is needed.
# The configured URL, as written: get-url would apply any insteadOf rewrite.
repo=$(git config --get remote.origin.url | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
checks=$(curl -fsS "https://api.github.com/repos/$repo/commits/$remote_sha/check-runs?check_name=ci")
conclusions=$(grep -o '"conclusion": *"[a-z_]*"' <<<"$checks" | sed -E 's/.*"([a-z_]*)"$/\1/' || true)
statuses=$(grep -o '"status": *"[a-z_]*"' <<<"$checks" | sed -E 's/.*"([a-z_]*)"$/\1/' || true)

if ! grep -qx success <<<"$conclusions"; then
  if [ -z "$statuses" ] || grep -qvx completed <<<"$statuses"; then
    exit 0 # CI hasn't finished yet; try again next tick
  fi
  # Checked again every tick, so a re-run that passes still deploys. Logged once.
  if [ "$remote_sha" != "$skipped_sha" ]; then
    log "CI failed for $remote_sha; not deploying"
    echo "$remote_sha" >"$state_dir/skipped"
  fi
  exit 0
fi

# A build can fail for a passing reason (apt, npm), so retry the same commit,
# but a commit that can't build shouldn't rebuild every tick forever
read -r failed_sha build_failures 2>/dev/null <"$state_dir/build-failures" || true
[ "${failed_sha:-}" = "$remote_sha" ] || build_failures=0
[ "${build_failures:-0}" -lt "${CORRAL_DEPLOY_BUILD_TRIES:-3}" ] || exit 0

log "building $remote_sha (deployed: ${deployed_sha:-nothing})"
git fetch --quiet origin "$branch"
# The deploy checkout has no local work; .env is untracked and survives this
git checkout --quiet --detach "$remote_sha"
CORRAL_BUILD_SHA=$(scripts/deploy/build-sha.sh "$remote_sha")
export CORRAL_BUILD_SHA
if ! docker compose build; then
  build_failures=$((${build_failures:-0} + 1))
  log "build failed for $remote_sha (try $build_failures of ${CORRAL_DEPLOY_BUILD_TRIES:-3}); not deploying"
  echo "$remote_sha $build_failures" >"$state_dir/build-failures"
  exit 1
fi
rm -f "$state_dir/build-failures"

if needs_hold; then
  # If the server can't be reached it isn't running anything worth waiting
  # for, and a broken server must not block the deploy that fixes it
  if api POST /update-hold >/dev/null 2>&1; then
    trap release EXIT
    trap 'exit 1' INT TERM
    log "holding new work until running work finishes"
    wait_for_idle
  else
    log "server not reachable; deploying without waiting"
  fi
fi

# The new server runs its migrations on start, and they can't be undone, so
# back up first. Anything it can't compare counts as a change. A retry after a
# failed start keeps the first backup, which is the one from before the migrations.
if [ "$(cat "$state_dir/backed-up" 2>/dev/null || true)" != "$remote_sha" ] \
  && { [ -z "$deployed_sha" ] || ! git diff --quiet "$deployed_sha" "$remote_sha" -- packages/db/migrations 2>/dev/null; }; then
  log "migrations may have changed; backing up first"
  CORRAL_DEPLOY_LOCK_HELD=1 scripts/deploy/backup.sh "pre-${remote_sha:0:7}" || { log "backup failed; not deploying"; exit 1; }
  echo "$remote_sha" >"$state_dir/backed-up"
fi

keep_previous_images

# --wait fails if a service isn't healthy in time. The commit then stays
# undeployed, so the next tick tries again; the EXIT trap lifts the hold.
if ! docker compose up -d --remove-orphans --wait --wait-timeout "${CORRAL_DEPLOY_WAIT_TIMEOUT:-180}"; then
  log "$remote_sha did not come up healthy; not recording it as deployed"
  exit 1
fi
# The new server starts without the hold
trap - EXIT
echo "$remote_sha" >"$state_dir/deployed"
log "deployed $remote_sha"
docker image prune -f >/dev/null || log "warning: could not prune old images"

# The deploy has happened whatever this says, so a failure is only a warning
report_deployment || log "warning: could not record the deployment on the server; release notes for it won't be written"
