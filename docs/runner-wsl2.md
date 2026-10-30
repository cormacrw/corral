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

Both the server and its local runner receive the same token. A missing token
fails Compose configuration. The listener binds `0.0.0.0:4200` *inside Docker*,
but the host publication defaults to `127.0.0.1:4200`, so remote access requires
explicitly choosing the tailnet address. Never use `0.0.0.0`, `::`, the LAN IP,
port forwarding on your router, or a Cloudflare Tunnel for this port. Port 4100
(the API) and Postgres are not published. Allow only the gaming PC to reach this
port in your Tailscale policy. Start Tailscale before Compose so the address exists.

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
`CORRAL_RUNNER_NAME` such as `gaming-pc`. Defaults are four slots and roles
`developer,reviewer,design`; the home-server runner continues handling PM work.
Never put model-provider tokens or GitHub credentials in either env or Compose
file. Only the human signs in to the CLIs; their configs persist on separate
runner-only named volumes (D2).

From `~/corral`, always use this Compose file and explicit env file:

```sh
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
wake a sleeping PC. Automatic code/image updates are covered by the separate
runner updater task; this guide configures startup and persistent authentication.
