# Remote runner deployment

`deploy/runner/docker-compose.yml` builds only the existing runner image, with
project-isolated data and CLI config volumes. Its `.env.example` defaults to
`gaming-pc`, four slots and `developer,reviewer,design`. Use the explicit
`--env-file deploy/runner/.env` when invoking Compose from the checkout root.

The home-server Compose now requires a shared `CORRAL_RUNNER_TOKEN` for server
and local runner. It enables the separate runner-only listener on container port
4200 and publishes it on `CORRAL_RUNNER_BIND_ADDRESS` (default loopback) and
`CORRAL_RUNNER_PORT` (default 4200). Operators set the binding to the home server's
Tailscale IPv4 address; port 4100 remains internal. This does not expose the API.

See `docs/runner-wsl2.md` for Docker Engine under systemd, Windows Tailscale,
user-owned Task Scheduler startup, foreground WSL keepalive, CLI sign-in and
manual reboot/end-to-end verification. Hardware checks require the actual PC;
Linux-only CI cannot demonstrate Windows reboot or Windows/WSL tailnet routing.
