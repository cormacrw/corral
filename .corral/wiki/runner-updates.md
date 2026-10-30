# Runner versions and draining

Protocol 3 advertises the image's `CORRAL_BUILD_SHA` and update policy in hello. Welcome and protocol refusal (4000, JSON close reason) report the server commit. Different commits mean behind; there is no ancestry lookup. Auto-deploy supplies the target SHA to both image builds. For manual Compose builds, export `CORRAL_BUILD_SHA=$(git rev-parse HEAD)` first.

`POST /api/runners/:runnerId/update` drains an online runner and sets `updateRequested`. Behind runners only drain automatically with `CORRAL_RUNNER_AUTO_UPDATE=true`. Drain removes runners from run placement, including affinity, without interrupting existing runs. Setup jobs prefer non-draining runners but use a draining runner if necessary; cleanup still broadcasts. A send-time guard also prevents assignments racing with drain.

The host updater (separate task) reads `<runner data dir>/update-status.json`, atomically replaced on state changes. Fields: commit, serverCommit, behind, draining, updateRequested, activeRunCount, idle. Drain is retained across reconnects, but a new runner process starts clear; restart on the server commit resumes placement. Remote runners pull from GitHub only after draining (D16).

COR-188 adds the WSL host updater: `scripts/deploy/runner-update.sh` runs under
`corral-runner-update.timer` every minute and at boot. It inspects the existing
runner's data mount on the host for advisory liveness. It reads the authoritative
target directly from authenticated `/runner/version`, with the immutable Docker
container configuration supplying the server URL/token, then fetches only
`origin/main` and refuses targets outside its reviewed history. A forged status
SHA never selects deployment code. It checks the running image SHA via Docker,
checks out the authenticated and reviewed server target,
builds locally with that SHA, then waits for draining + idle + zero active runs
(including terminal reports) before runner-only `up -d --no-build`. A lock avoids
overlap. Current runners log and exit without Git or Compose mutations. The
runner-only compose defaults auto-update on; manual-only policy remains supported.

The host atomically writes `updater-result.json` (target, state, error, attempt). The runner
polls it even while disconnected and publishes `runner.update-status` to Settings;
a failed build clears draining and updateRequested so the old process takes work.
The files have separate writers. A new process ignores results for its own commit.
Settings shares `RunnerUpdate` on desktop/mobile, including retry, remaining runs,
waiting/building, offline replacement, failure and the online commit. Prototype
fixtures expose each state. See `docs/runner-wsl2.md` for root service installation,
checkout ownership, journald and the Windows startup task needed to boot WSL.

Review hardening: `runner-update-io.py` handles untrusted volume I/O. It walks
absolute mount paths with directory descriptors and O_NOFOLLOW, reads only a
bounded regular status file, creates random O_EXCL/O_NOFOLLOW feedback files,
fchmods the open file descriptor, and renames relative to the pinned directory.
Pre-created temporary/destination symlinks and concurrent parent replacement
cannot overwrite or chmod external host files. The dedicated host checkout must
not be mounted into agent containers. Host Python 3 is a documented prerequisite.
