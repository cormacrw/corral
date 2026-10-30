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
