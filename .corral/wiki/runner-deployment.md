# Remote runner deployment

`deploy/runner/docker-compose.yml` builds only the existing runner image, with
project-isolated data and CLI config volumes. Its `.env.example` defaults to
`gaming-pc`, four slots and `developer,reviewer,design`. Use the explicit
`--env-file deploy/runner/.env` when invoking Compose from the checkout root.
Export `CORRAL_BUILD_SHA=$(git rev-parse HEAD)` before building: the runner-only
Compose passes it to the image, just like the home-server Compose. It also passes
`CORRAL_RUNNER_AUTO_UPDATE`, defaulting to `false`. Leave that off until the
COR-188 updater timer is installed, or a behind runner drains without anything
to rebuild it. For manual updates, pause projects and wait for active runs, update the
checkout to the server commit, export the SHA again and rebuild; exact commands
are in the WSL2 guide. The future updater must export the same build variable.

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
fit Docker's default 10 s stop timeout. If the push doesn't finish, the commit
stays in the worktree for the next run on that runner, and the run's transcript
says so. A worktree that isn't on the task branch (mid-rebase) is left alone.
The run's `headSha` records the pushed commit and the job's `continueFrom`
carries it to the retry; a kept worktree on another runner fast-forwards to it
and fails the run if it has diverged. After a human stop or the kill switch the
server ends the run at once, so a Resume within seconds builds its prompt before
`wipSha` arrives. That retry waits for the save and starts from the commit, but
its prompt can't name it.

Outside signals are classified for both newly spawned agents and a PM process
reused for a later warm turn. A process that exits before replying ends that
turn with the signal name, rather than an unexplained null or 128+n exit code.
