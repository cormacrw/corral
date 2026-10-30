#!/usr/bin/env bash
# Host only. Never mount the Docker socket in the runner.
set -Eeuo pipefail
# Parse the whole operation before checkout can replace this script.
main() {
  cd "$(dirname "$(readlink -f "$0")")/../.."
  exec 9>deploy/runner/.update.lock
  flock -n 9 || exit 0
  compose=(docker compose --env-file deploy/runner/.env -f deploy/runner/docker-compose.yml)
  # Inspect the existing container rather than guessing Docker's volume location.
  data=$(docker inspect corral-remote-runner --format '{{range .Mounts}}{{if eq .Destination "/data/runner"}}{{.Source}}{{end}}{{end}}')
  [[ -n "$data" && -r "$data/update-status.json" ]] || { echo 'Runner status unavailable'; exit 0; }
  status="$data/update-status.json"
  target=$(jq -r '.serverCommit // empty' "$status")
  [[ "$target" =~ ^[0-9a-f]{40}$ ]] || { echo 'Server commit not known yet'; exit 0; }
  if [[ $(jq -r .commit "$status") == "$target" ]]; then
    echo "Runner is up to date ($target)"
    exit 0
  fi
  jq -e '.draining or .updateRequested' "$status" >/dev/null || { echo 'Behind; automatic updates disabled'; exit 0; }
  attempt="$(date +%s%N)-$$"
  feedback() {
    jq -n --arg target "$target" --arg state "$1" --arg error "${2:-}" --arg attempt "$attempt" '{target:$target,state:$state,error:$error,attempt:$attempt}' > "$data/updater-result.json.tmp"
    chmod 644 "$data/updater-result.json.tmp"
    mv "$data/updater-result.json.tmp" "$data/updater-result.json"
  }
  failure='Host updater failed; inspect journalctl -u corral-runner-update'
  failed() { feedback failed "$failure"; echo 'Update failed; old runner retained, drain released'; }
  trap failed ERR
  # Refuse to overwrite local edits. The updater's checkout is dedicated to deployment.
  [[ -z $(git status --porcelain --untracked-files=no) ]]
  echo "Fetching server commit $target"
  git fetch origin
  git cat-file -e "$target^{commit}" || git fetch origin "$target"
  git checkout --detach "$target"
  export CORRAL_BUILD_SHA="$target"
  feedback building
  echo "Building $target while the old runner continues"
  failure='Runner image build failed; inspect journalctl -u corral-runner-update'
  "${compose[@]}" build runner
  failure='Runner replacement failed; inspect journalctl -u corral-runner-update'
  feedback waiting
  echo 'Waiting for drain and all terminal run reports'
  while ! jq -e --arg target "$target" '.serverCommit == $target and .draining and .idle and .activeRunCount == 0' "$status" >/dev/null; do
    # A server deploy during this build needs a fresh build on the next tick.
    [[ $(jq -r .serverCommit "$status") == "$target" ]] || { echo 'Server target changed; retry next tick'; exit 0; }
    sleep 2
  done
  feedback restarting
  echo "Replacing idle runner with $target"
  "${compose[@]}" up -d --no-build runner
  echo 'Runner replaced; it will reconnect with the new commit'
}
main "$@"
