# Remote runner deployment

`deploy/runner/docker-compose.yml` builds only the existing runner image, with
project-isolated data and CLI config volumes. Its `.env.example` defaults to
`gaming-pc`, four slots and `developer,reviewer,design`. Use the explicit
`--env-file deploy/runner/.env` when invoking Compose from the checkout root.

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
