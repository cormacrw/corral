# Runner-only deployment on the gaming PC (WSL2)

Use current Windows 11 (22H2 or newer), current Store WSL2, and Ubuntu 24.04.
Docker Engine runs **inside Ubuntu under systemd**, without Docker Desktop.
The home server still runs the control plane. This machine only dials out to its
private runner listener; it publishes no ports and needs no inbound Windows rule.

## Prepare the home server

In the home-server checkout, copy `.env.docker.example` to `.env` if needed;
preserve existing database and public URL settings. Generate a shared runner
secret with `openssl rand -hex 32`. Set `CORRAL_RUNNER_TOKEN` to that secret and
`CORRAL_RUNNER_BIND_ADDRESS` to the home server's **Tailscale IPv4 address**
(`tailscale ip -4`, e.g. `100.90.80.70`). Leave `CORRAL_RUNNER_PORT=4200`, or
choose an unused host port. Then run `docker compose up -d --build`.

Both the server and its local runner receive the same token. Without a token
the listener stays off and the local runner keeps working on the private Docker
network, so an existing `.env` keeps deploying. The listener binds `0.0.0.0:4200` *inside Docker*,
but the host publication defaults to `127.0.0.1:4200`, so remote access requires
explicitly choosing the tailnet address. Never use `0.0.0.0`, `::`, the LAN IP,
port forwarding on your router, or a Cloudflare Tunnel for this port. Port 4100
(the API) and Postgres are not published. Allow only the gaming PC to reach this
port in your Tailscale policy.

Docker can't publish on an address the host doesn't have yet, and after a reboot
it may start before Tailscale. Let it bind early, or the server container won't
come back after a reboot:

```sh
echo 'net.ipv4.ip_nonlocal_bind=1' | sudo tee /etc/sysctl.d/90-corral-tailscale.conf
sudo sysctl --system
```

After configuring the tailnet binding, in Windows PowerShell run
`Test-NetConnection <home-server-tailnet-name> -Port 4200` (expect
`TcpTestSucceeded: True`). From a LAN device without Tailscale, run
`Test-NetConnection <home-server-LAN-IP> -Port 4200` (expect False).
Use your chosen host port in both checks. With the default loopback binding,
both remote checks should fail. Verify the listener also has no public router
forward or tunnel; keep these reachability results for deployment evidence.

## Prepare Windows and Ubuntu

In PowerShell, run `wsl --update`, check `wsl --list --verbose`, and ensure Ubuntu
is version 2 (`wsl --set-version Ubuntu 2` if necessary). Substitute your actual
distro name everywhere below. Launch Ubuntu and edit `/etc/wsl.conf` with sudo,
preserving any existing sections:

```ini
[boot]
systemd=true
```

Edit `%USERPROFILE%\.wslconfig` on Windows (merge with existing settings):

```ini
[wsl2]
networkingMode=nat
dnsTunneling=true
vmIdleTimeout=-1
```

The timeout setting disables idle VM shutdown; the scheduled foreground process
below also keeps the distro alive. Systemd services alone do not do that.
Allow enough WSL memory for the runner's 6 GiB container limit plus Ubuntu and
Docker overhead; lower `CORRAL_RUNNER_MEMORY` and slots together on smaller PCs.
Run `wsl --shutdown` in PowerShell to apply these settings (this stops all WSL
distros), then reopen Ubuntu. Check `ps -p 1 -o comm=` prints `systemd`.
See Microsoft's [WSL settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
and [networking guide](https://learn.microsoft.com/en-us/windows/wsl/networking).

Install Docker Engine from Docker's official Ubuntu apt repository, following
[Install using the apt repository](https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository).
Install `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin` and
`docker-compose-plugin`, then in Ubuntu:

```sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
sudo apt-get update
sudo apt-get install -y git curl
```

Exit and reopen Ubuntu for group membership. Verify `systemctl is-enabled docker`,
`docker run --rm hello-world`, and `docker compose version`. Docker group access
grants root-equivalent control of this distro. Do not mount its socket in Corral.

Install and sign in to [Tailscale on Windows](https://tailscale.com/download/windows)
using the same tailnet as the home server. Enable **Run unattended** in Tailscale's
Windows preferences so connectivity survives reboot/logout. Do not install a
second Tailscale client inside Ubuntu for this setup. Traffic goes container →
Docker bridge → WSL NAT → Windows → Tailscale → home server. DNS tunneling lets
WSL use Windows DNS; Docker DNS can differ, so check from the container too.
Use the home server's full MagicDNS name (e.g. `home-server.example.ts.net`);
if Docker cannot resolve it, use its stable `100.x.y.z` Tailscale address instead.

## Clone, configure and sign in

Clone into the Linux filesystem, **not `/mnt/c`**, to preserve Linux permissions
and avoid slow agent worktrees. Use your normal GitHub checkout authentication
for a private repository; this is separate from the runner container's login.

```sh
cd ~
git clone https://github.com/cormacrw/corral.git
cd ~/corral
cp deploy/runner/.env.example deploy/runner/.env
chmod 600 deploy/runner/.env
```

Edit `deploy/runner/.env`: set `CORRAL_SERVER_URL` to
`http://<home-server-tailnet-name>:4200` (use the configured host port), copy the
shared `CORRAL_RUNNER_TOKEN`, and set the git author name/email. Choose a unique
`CORRAL_RUNNER_NAME` such as `gaming-pc`. Slots default to the smaller CPU/memory budget count (2 CPUs and 2.5 GiB per slot, at least one); `CORRAL_RUNNER_SLOTS` overrides it. Default roles are
`developer,reviewer,design`; the home-server runner continues handling PM work.
Never put model-provider tokens or GitHub credentials in either env or Compose
file. Only the human signs in to the CLIs; their configs persist on separate
runner-only named volumes (D2).

From `~/corral`, always use this Compose file and explicit env file:

```sh
export CORRAL_BUILD_SHA=$(git rev-parse HEAD)
docker compose --env-file deploy/runner/.env -f deploy/runner/docker-compose.yml up -d --build
docker exec -it corral-remote-runner claude
docker exec -it corral-remote-runner codex login --device-auth
docker exec -it corral-remote-runner gh auth login
```

Complete Claude's browser login and exit the CLI. Follow Codex's device-code
instructions in your Windows browser. For GitHub choose GitHub.com, HTTPS and
browser login; authorize access to the repositories the runner will work on.
Then configure Git's GitHub credential helper and check authentication:

```sh
docker exec corral-remote-runner gh auth setup-git
docker exec corral-remote-runner gh auth status
docker exec corral-remote-runner codex login status
docker exec corral-remote-runner sh -c 'curl --connect-timeout 10 -i "$CORRAL_SERVER_URL/api/health"'
docker compose --env-file deploy/runner/.env -f deploy/runner/docker-compose.yml logs --tail=100 runner
```

The curl must reach the dedicated listener and return **404**, because it does
not serve the API. A timeout means routing, binding or Tailscale policy is wrong;
DNS failure means try the Tailscale IP. Authentication errors in runner logs mean
the shared tokens differ. Do not paste secrets or CLI credential files into logs
or evidence. Recreate the container after login if its capabilities have not yet
refreshed: `docker compose --env-file deploy/runner/.env -f deploy/runner/docker-compose.yml restart runner`.

Open Corral's **Settings → Runner** page (`/settings/runner`) and confirm `gaming-pc` (or your configured name) is
online with the expected roles, slots and CLI availability. Its data volume
preserves its runner identity across container recreation. Do not run `down -v`;
that deletes the runner identity, worktrees and CLI logins.

## Update the runner by hand

Leave `CORRAL_RUNNER_AUTO_UPDATE=false` in `deploy/runner/.env` until the
updater timer (COR-188) is installed. With it enabled, a behind runner drains
itself and takes no new work until something updates it. With it off, the runner
shows as behind but keeps taking work.

Until COR-188 lands, pause the projects this runner serves and wait for its
active runs to finish before rebuilding. In Ubuntu, update to
the same commit deployed on the home server (different commits count as behind):

```sh
cd ~/corral
git fetch origin
git switch main
git pull --ff-only origin main
# If the home server is not on the latest main, use its deployed commit instead:
# git switch --detach <server-commit>
export CORRAL_BUILD_SHA=$(git rev-parse HEAD)
docker compose --env-file deploy/runner/.env -f deploy/runner/docker-compose.yml up -d --build
```

Confirm the runner reconnects in Settings → Runner. Check `GET /api/status`
on the control plane: its `commit` should match `serverCommit`, with `behind`
and `draining` both `false`. Resume the paused projects. Rebuilding preserves
the named volumes and CLI logins. The COR-188 updater must also set `CORRAL_BUILD_SHA` to the checked-out
commit before building; otherwise the image reports `development`.

## Start automatically after reboot

In **Windows Task Scheduler**, create a task named `Corral WSL runner` under the
**same Windows user that owns the Ubuntu distro** (not SYSTEM). Configure:

- General: **Run whether user is logged on or not**. Save with that account's
  password so startup can run before login; update it if the password changes.
- Triggers: **At startup**, delay 30 seconds; also **At log on** for this user as
  a fallback. Enable both triggers.
- Action: program `C:\Windows\System32\wsl.exe`; arguments
  `--distribution Ubuntu --user root --exec /usr/bin/sleep infinity`.
- Conditions: clear **Start the task only if the computer is on AC power**, **Stop
  if the computer switches to battery power**, and idle-only conditions.
- Settings: allow on-demand execution; run as soon as possible after a missed
  start; restart on failure every minute (up to 999 attempts); clear **Stop the
  task if it runs longer than…**; if already running, **Do not start a new instance**.

Run the task once. A persistent **Running** status is expected: `sleep infinity`
keeps WSL alive without a console. Systemd starts Docker, and Docker restores the
existing container through `restart: unless-stopped`. Compose does not need to
run on every boot. A container deliberately stopped with `docker compose stop`
or removed with `down` will not return: run the `up -d` command to enable it again.

Reboot the PC and log in to Windows. **Before opening WSL or running any command**,
open Corral from a browser (or another device) and confirm the configured runner
returns online. Capture the Settings → Runner page and Task Scheduler's running task as
reboot evidence. If it stays offline, inspect Task Scheduler history, the account
and distro name, Tailscale's unattended mode, then Docker's enabled status and
runner logs. A task registered as SYSTEM cannot see your user-owned distro.

## Verify a real task and sleep behaviour

Use the test project `cormacrw/test-app` (target branch `main`), initially paused.
Give a small developer task a description and an observable acceptance criterion
(e.g. a visible copy change). After ensuring other runners have no active runs, temporarily stop their
runner containers so this runner is selected. Then unpause the project and move
the task to Ready. Confirm
the run lists the gaming-PC runner, it claims the task, produces a PR against
test-app and attaches human-viewable evidence. Keep it in human review; do not
merge the test PR. Record its URL, branch and evidence, then restore the project pause setting and restart the other runner containers. This verifies GitHub write access and evidence upload in
addition to the online heartbeat. Repeat for each runtime you intend to use.

Disable automatic sleep while you want the PC to work. If it sleeps mid-run,
heartbeats stop; when the lease expires the run is interrupted and its work is
redone. On wake the runner reconnects, but the old lease cannot submit results.
Windows shutdown and `wsl --shutdown` also interrupt work. This setup does not
wake a sleeping PC. The host updater below handles code and image updates.

## Enable the host updater

The checkout is dedicated to deployment: do not edit tracked files there. The
updater obtains the server's exact SHA directly from the authenticated
`/runner/version` endpoint, using the server URL and token in Docker's host-owned
container configuration. It does not trust a target supplied by agent-writable
volume files. Before checkout it fetches only `origin/main` and requires the
server SHA to be an ancestor of that reviewed branch. An unmerged task-branch
server build is deliberately refused; the existing runner keeps running.
The SHA need not be the newest commit on main. GitHub checkout authentication
must work unattended for root (the system service user); for a public repo HTTPS needs no credentials. Runner
CLI authentication remains separate. Keep this deployment checkout and its
`.git`/`.env` configuration outside all container mounts and writable only by
trusted host administrators. Never bind-mount the checkout into agent containers.
The default runner-data Docker volume path must have real directory components;
symlinked mount paths are refused. Feedback uses an exclusively created temporary
file and a pinned directory handle, so malicious volume symlinks cannot redirect
root writes or chmods to host files. No registry or image publishing is used.

Install Python 3, `jq` and the timer inside Ubuntu, adjusting the service's checkout path:

```sh
sudo apt-get install -y jq python3
sudo cp scripts/deploy/corral-runner-update.{service,timer} /etc/systemd/system/
sudo systemctl edit --full corral-runner-update.service
# Set ExecStart to the absolute path of scripts/deploy/runner-update.sh in this checkout.
sudo git config --global --add safe.directory "$PWD"
sudo systemctl daemon-reload
sudo systemctl enable --now corral-runner-update.timer
systemctl list-timers corral-runner-update.timer
```

After installing the timer, set `CORRAL_RUNNER_AUTO_UPDATE=true` in
`deploy/runner/.env` and recreate the runner to enable automatic updates. Keep
the default false for manual-only updates. Settings → Runner →
**Update now** requests a drain; the next minute's timer builds while existing
runs finish, then replaces only the idle runner. Status shows the old and server
commits, draining runs, waiting, offline during replacement, and the new commit
on reconnect. Build failures release the drain and show **Update failed**; retry
with Update now after fixing the host problem. Inspect host logs with
`sudo journalctl -u corral-runner-update.service`. The lock prevents overlap.

The enabled timer starts on every distro boot. The Windows startup task above
starts and keeps that distro alive after a PC reboot; systemd alone cannot start
WSL. Verify both the enabled timer and the Windows task, then reboot and observe
the runner returning in Settings without opening a WSL shell. A sleeping or
powered-off PC cannot update. Never mount the Docker socket into any container.
