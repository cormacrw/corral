# Runner versions and draining

Protocol 3 advertises the image's `CORRAL_BUILD_SHA` and update policy in hello. Welcome and protocol refusal (4000, JSON close reason) report the server commit. Different commits mean behind; there is no ancestry lookup. Auto-deploy supplies the same SHA to both image builds: the last commit that touched a backend input (`scripts/deploy/build-sha.sh`), so docs-only and web-only commits never mark a runner behind. Manual builds go through `scripts/deploy/compose.sh`, which sets it.

`POST /api/runners/:runnerId/update` drains an online runner and sets `updateRequested`. Behind runners only drain automatically with `CORRAL_RUNNER_AUTO_UPDATE=true`. Drain removes runners from run placement, including affinity, without interrupting existing runs. Setup jobs prefer non-draining runners but use a draining runner if necessary; cleanup still broadcasts. A send-time guard also prevents assignments racing with drain.

The host updater reads `<runner data dir>/update-status.json`, atomically replaced on state changes. Fields: commit, serverCommit, behind, draining, updateRequested, activeRunCount, idle. Drain is retained across reconnects, but a new runner process starts clear; restart on the server commit resumes placement. Remote runners pull from GitHub only after draining (D16).

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
runner-only compose defaults auto-update off until the host timer is installed;
set CORRAL_RUNNER_AUTO_UPDATE=true and recreate the runner to enable it.

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
Pre-created temporary/destination symlinks and concurrent task replacement
cannot overwrite or chmod external host files. The dedicated host checkout must
not be mounted into agent containers. Host Python 3 is a documented prerequisite.

## Tool contracts (COR-435)

COR-431's `stuck` reports were refused for a missing `decision` the agents couldn't send: `gaming-pc` was still on an older build while the server enforced the field. Being behind doesn't stop work unless `CORRAL_RUNNER_AUTO_UPDATE=true`, and that flag was off with the host timer installed, so the timer logged "Behind; automatic updates disabled" until a human pressed Update now.

Agent tool definitions now live in `@corral/contracts/agent-tools` (a Node-only entry). Hello carries `AGENT_TOOL_CONTRACT`, a hash of what each role's agent sees: names, descriptions, input schemas and outcomes. A hash that differs, or is missing, sets `toolContractReason`. The hub then:

- keeps the runner out of agent runs in `pickRunner` and at `send`, separately from `draining`, because a failed update releases the drain so that setup jobs keep working;
- drains it whatever its auto-update flag says. The flag is the runner's own policy for being merely behind. `update-status.json` then says draining, and the timer's gate passes, so a host with the timer updates with no human step.

## Telling a human

`runnerUpdateProblem` (`@corral/contracts/client`, shared with web) is the rule for the `runner_update` Needs you item: a behind runner whose update failed, or one with differing tools that shows no attempt `RUNNER_UPDATE_GRACE_MS` after connecting. The second catches a host with no timer and updater exits before its `ERR` trap, which write no feedback. A runner refused at the protocol check counts too: it's offline, so Update now can't reach it, and on a protocol close (`RUNNER_CLOSE_CODES.protocol`) it drains itself (`UpdateStatus.refused`) whatever its flag says, which passes the timer's gate. Only runners with this code do that; an older one is reported but needs a hand. `#turnAway` keeps the first refusal's `connectedAt`, or a grace period measured from it would restart with every retry. Runners are in memory, so `loadInbox` adds the item (`runnerUpdateItems` in `apps/server/src/inbox.ts`), and the web's `runner.status` handler refetches the Inbox only when the listed runners change, since heartbeats land there too. A failed update doesn't retry itself: the item's Retry update sends the drain again, and a new server commit does on reconnect.
