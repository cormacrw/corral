# Auto-deploy on the home server (D16)

`auto-deploy.sh` redeploys Corral whenever `main` moves and CI on the new
commit has passed, without interrupting agent runs. A systemd timer runs it every minute on the server. It pulls
from GitHub, so nothing extra goes through the Cloudflare Tunnel and GitHub
holds no credentials for the server.

## Install

On the server, in the checkout you run `docker compose` from (with `.env` in
place, as in the main README):

```sh
sudo cp scripts/deploy/corral-deploy.{service,timer} /etc/systemd/system/
sudo sed -i "s#/opt/corral#$PWD#; s#^User=.*#User=$(stat -c %U .)#" /etc/systemd/system/corral-deploy.service
sudo systemctl daemon-reload
sudo systemctl enable --now corral-deploy.timer
```

The service must run as the user who owns the checkout, and that user must be
able to run `docker` without sudo (`sudo usermod -aG docker <user>`, then log
in again). As any other user, root included, git refuses the repository
("dubious ownership") and the deploy fails. A `sudo git …` test won't show
this, because git trusts root when it comes in through sudo; systemd doesn't
use sudo. To check: `sudo -u <user> git -C <checkout> ls-remote origin`.

Without systemd, a cron line does the same:

```cron
* * * * * /path/to/corral/scripts/deploy/auto-deploy.sh >>/path/to/corral/.corral/deploy/log 2>&1
```

## Operating it

- Logs: `journalctl -u corral-deploy -f`
- Deploy now: `sudo systemctl start corral-deploy`
- Pause: `sudo systemctl stop corral-deploy.timer`
- State lives in `.corral/deploy/`: `deployed` is the last deployed commit,
  `skipped` the last commit whose CI or build failed. Delete `deployed` to force a rebuild.
- The checkout is left detached at the deployed commit. Don't keep local
  changes in it; `.env` is untracked and is never touched.

## Agent runs are never cut off

Restarting `server` or `runner` would interrupt agent runs: the runner loses
its agents, and while the server is down the runner's messages are dropped.
So when a deploy would restart anything other than `web`, the script first
puts the server on its **update hold** (`POST /api/update-hold`):

- No new runs, PM turns or merges start. The app shows an "updating" banner.
- Running work carries on. The script polls until nothing is running, then
  restarts. Every run has a time limit, so the wait always ends.
- The hold is in memory, so the new server starts without it. If the deploy
  fails, the script lifts it (`DELETE /api/update-hold`).

Images are built before the hold, so the wait covers only running work, not
the build. A change that only touches `web` deploys straight away. If the
server can't be reached, the script deploys without waiting, so a broken
server never blocks the fix.
