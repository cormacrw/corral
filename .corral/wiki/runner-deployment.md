# Remote runner deployment

`deploy/runner/docker-compose.yml` builds only the existing runner image, with
project-isolated data and CLI config volumes. Its `.env.example` defaults to
`gaming-pc`, resource-derived slots and `developer,reviewer,design`. Use the explicit
`--env-file deploy/runner/.env` when invoking Compose from the checkout root.
Build through `scripts/deploy/compose.sh`, which sets `CORRAL_BUILD_SHA` from
`build-sha.sh`: the runner-only Compose passes it to the image, just like the
home-server Compose. It also passes `CORRAL_RUNNER_AUTO_UPDATE`, defaulting to
`false`. Leave that off unless the updater timer is installed, or a behind runner
drains without anything to rebuild it. For manual updates, pause projects and
wait for active runs, update the checkout to the server commit and rebuild; exact
commands are in the WSL2 guide. See `runner-updates.md` for the updater.

The home-server Compose passes a shared `CORRAL_RUNNER_TOKEN` to server and local
runner. With the token set it enables the separate runner-only listener on
container port 4200; without one the listener stays off, so a deployed `.env`
without a token still deploys. The port is published on `CORRAL_RUNNER_BIND_ADDRESS` (default loopback) and
`CORRAL_RUNNER_PORT` (default 4200). Operators set the binding to the home server's
Tailscale IPv4 address; port 4100 remains internal. This does not expose the API.

See `docs/runner-wsl2.md` for Docker Engine under systemd, Windows Tailscale,
user-owned Task Scheduler startup, foreground WSL keepalive, CLI sign-in and
manual reboot/end-to-end verification. Hardware checks require the actual PC;
Linux-only CI cannot demonstrate Windows reboot or Windows/WSL tailnet routing.

## How a stopped run reads

A run's error says what cut it off: its time limit, the server's stop reason, a
runner shutdown, or a signal from outside Corral, plus the last transcript
activity. A runner SIGTERM (`docker compose up -d` recreating the container)
ends runs as Interrupted once `run.ended` has gone out. If the server is
unreachable at that moment, the run ends as "The runner restarted during the
run" when the runner reconnects. An older runner on the same protocol
version sends none of the new exit fields, and its runs read as they did.

A developer run stopped before reporting commits its uncommitted changes as a
`WIP:` commit (hooks skipped) and pushes the task branch after the agent exits.
That has `STOP_GRACE_MS` (5 s), on top of the agent's own 5 s, which together
have margin within the runner Compose services' 20 s stop timeout. If the push doesn't finish, the commit
stays in the worktree for the next run on that runner, and the run's transcript
says so. A WIP push requires an open connection and an unexpired lease acknowledgement
from run start or a heartbeat (two heartbeat intervals, with at least 5 s left).
The acknowledgement echoes the runner's request timestamp, so delayed replies
expire even if the hosts' clocks differ. After sleep or disconnection the commit stays local, even if the socket still
looks open. A no-keepWork stop revokes that acknowledgement, including during
a save. This bounds stale pushes but cannot fence a revocation still in transit
at GitHub. A run a human or the kill switch stopped stays listed in heartbeats
until its agent exits; the server doesn't revoke it then, unless a newer run
holds the task or the task was deleted. A worktree that isn't on the task branch (mid-rebase) is left alone.
The run's `headSha` records the pushed commit and the job's `continueFrom`
carries it to the retry; a kept worktree on another runner fast-forwards to it
and fails the run if it has diverged. After a human stop or the kill switch the
server ends the run at once, so a Resume within seconds builds its prompt before
`wipSha` arrives. That retry waits for the save and starts from the commit, but
its prompt can't name it yet and asks the agent to check the branch log.
For runner-originated exits, the WIP SHA is recorded in the same transaction
that releases the lease, before another scheduling pass can claim the task.
Stopped-work lookup is per task, independent of developer or session; session
resume stays scoped to the developer. Reported failures store their summary
and are excluded from the stopped-run prompt.

Outside signals are classified for both newly spawned agents and a PM process
reused for a later warm turn. A process that exits before replying ends that
turn with the signal name, rather than an unexplained null or 128+n exit code.

## Resource-derived capacity (COR-253)

Leave `CORRAL_RUNNER_SLOTS` unset (or empty) to derive slots at startup from
available CPU affinity, host memory and visible Linux cgroup v1/v2 quotas,
including parent limits. Defaults are 2 CPUs and 2.5 GiB per slot, configurable
with `CORRAL_SLOT_CPUS` and `CORRAL_SLOT_MEMORY`. Both Compose files pass these
budgets without forcing a slot override. An existing explicit slot setting
continues to win. Settings shows the source, detected resources and budgets;
older runner versions show an unavailable source. See architecture resource
expectations for sizing and headroom.
