#!/usr/bin/env bash
# Host only. Never mount the Docker socket in the runner.
set -Eeuo pipefail
# Parse the whole operation before checkout can replace this script.
main() {
  cd "$(dirname "$(readlink -f "$0")")/../.."
  exec 9>deploy/runner/.update.lock
  flock -n 9 || exit 0
  compose=(docker compose --env-file deploy/runner/.env -f deploy/runner/docker-compose.yml)
  io="$PWD/scripts/deploy/runner-update-io.py"
  # Docker configuration and the private authenticated listener are host-trusted;
  # volume contents are only advisory drain/liveness data, never deployment code.
  inspection=$(docker inspect corral-remote-runner)
  data=$(jq -r '.[0].Mounts[] | select(.Destination == "/data/runner") | .Source' <<< "$inspection")
  [[ -n "$data" ]] || { echo 'Runner mount unavailable'; exit 0; }
  target=$(python3 "$io" target <<< "$inspection")
  snapshot=$(python3 "$io" status "$data")
  [[ $(jq -r .serverCommit <<< "$snapshot") == "$target" ]] || { echo 'Untrusted runner target disagrees with control plane; refusing update'; exit 1; }
  # Read the actual running image commit from Docker, not the writable status file.
  running=$(jq -r '.[0].Config.Env[] | select(startswith("CORRAL_BUILD_SHA=")) | ltrimstr("CORRAL_BUILD_SHA=")' <<< "$inspection")
  if [[ "$running" == "$target" ]]; then
    echo "Runner is up to date ($target)"
    exit 0
  fi
  jq -e '.draining or .updateRequested' <<< "$snapshot" >/dev/null || { echo 'Behind; automatic updates disabled'; exit 0; }
  attempt="$(date +%s%N)-$$"
  feedback() {
    python3 "$io" feedback "$data" "$target" "$1" "${2:-}" "$attempt"
  }
  failure='Host updater failed; inspect journalctl -u corral-runner-update'
  failed() { feedback failed "$failure"; echo 'Update failed; old runner retained, drain released'; }
  trap failed ERR
  # Refuse to overwrite local edits. The updater's checkout is dedicated to deployment.
  [[ -z $(git status --porcelain --untracked-files=no) ]]
  echo "Fetching server commit $target"
  git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
  # Only reviewed main history may supply Dockerfiles, Compose or updater code.
  git merge-base --is-ancestor "$target" refs/remotes/origin/main || { echo 'Refusing deployment code outside trusted origin/main history'; false; }
  git checkout --detach "$target"
  export CORRAL_BUILD_SHA="$target"
  feedback building
  echo "Building $target while the old runner continues"
  failure='Runner image build failed; inspect journalctl -u corral-runner-update'
  "${compose[@]}" build runner
  failure='Runner replacement failed; inspect journalctl -u corral-runner-update'
  feedback waiting
  echo 'Waiting for drain and all terminal run reports'
  while ! snapshot=$(python3 "$io" status "$data") || ! jq -e --arg target "$target" '.serverCommit == $target and .draining and .idle and .activeRunCount == 0' <<< "$snapshot" >/dev/null; do
    # A server deploy during this build needs a fresh build on the next tick.
    [[ $(jq -r .serverCommit <<< "$snapshot") == "$target" ]] || { echo 'Server target changed; retry next tick'; exit 0; }
    sleep 2
  done
  # Revalidate the host-trusted target after a long drain/build.
  [[ $(python3 "$io" target <<< "$inspection") == "$target" ]] || { echo 'Control-plane target changed; retry next tick'; exit 0; }
  feedback restarting
  echo "Replacing idle runner with $target"
  "${compose[@]}" up -d --no-build runner
  echo 'Runner replaced; it will reconnect with the new commit'
}
main "$@"
