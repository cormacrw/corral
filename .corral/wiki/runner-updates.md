# Runner versions and draining

Protocol 3 advertises the image's `CORRAL_BUILD_SHA` and update policy in hello. Welcome and protocol refusal (4000, JSON close reason) report the server commit. Different commits mean behind; there is no ancestry lookup. Auto-deploy supplies the target SHA to both image builds. For manual Compose builds, export `CORRAL_BUILD_SHA=$(git rev-parse HEAD)` first.

`POST /api/runners/:runnerId/update` drains an online runner and sets `updateRequested`. Behind runners only drain automatically with `CORRAL_RUNNER_AUTO_UPDATE=true`. Drain removes runners from run placement, including affinity, without interrupting existing runs. Setup jobs prefer non-draining runners but use a draining runner if necessary; cleanup still broadcasts. A send-time guard also prevents assignments racing with drain.

The host updater (separate task) reads `<runner data dir>/update-status.json`, atomically replaced on state changes. Fields: commit, serverCommit, behind, draining, updateRequested, activeRunCount, idle. Drain is retained across reconnects, but a new runner process starts clear; restart on the server commit resumes placement. Remote runners pull from GitHub only after draining (D16).
