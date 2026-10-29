# Auto-deploy on the home server (D16)

`auto-deploy.sh` redeploys Corral whenever `main` moves and CI on the new
commit has passed, without interrupting agent runs. A systemd timer runs it every 20 minutes on the server, so several merges usually go out in one deploy (and one hold). It pulls
from GitHub, so nothing extra goes through the Cloudflare Tunnel and GitHub
holds no credentials for the server.

## Install

On the server, in the checkout you run `docker compose` from (with `.env` in
place, as in the main README):

```sh
sudo cp scripts/deploy/corral-{deploy,backup}.{service,timer} /etc/systemd/system/
sudo sed -i "s#/opt/corral#$PWD#; s#^User=.*#User=$(stat -c %U .)#" /etc/systemd/system/corral-{deploy,backup}.service
sudo systemctl daemon-reload
sudo systemctl enable --now corral-deploy.timer corral-backup.timer
```

The service must run as the user who owns the checkout, and that user must be
able to run `docker` without sudo (`sudo usermod -aG docker <user>`, then log
in again). As any other user, root included, git refuses the repository
("dubious ownership") and the deploy fails. A `sudo git …` test won't show
this, because git trusts root when it comes in through sudo; systemd doesn't
use sudo. To check: `sudo -u <user> git -C <checkout> ls-remote origin`.

Without systemd, a cron line does the same:

```cron
*/20 * * * * /path/to/corral/scripts/deploy/auto-deploy.sh >>/path/to/corral/.corral/deploy/log 2>&1
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

- **Draining:** no new developer, reviewer or design runs or merges start.
  PM turns still start, so Plan chat and Inbox replies remain available.
- **Finishing:** once no non-PM runs or merges remain, new PM turns are saved
  as `queued` runs holding their jobs for after the update. Running PM turns
  finish first. Both phases show the "updating" banner.
- The unchanged polling loop waits for `busy` to reach zero: running PM turns
  count, queued PM turns still holding their jobs do not. Every running turn
  has a time limit, so new messages cannot extend the finishing phase.
- The hold is in memory, so the new server starts without it. If the deploy
  fails, the script lifts it (`DELETE /api/update-hold`). Either starts queued PM turns.

Images are built before the hold, so the wait covers only running work, not
the build. A change that only touches `web` deploys straight away. If the
server can't be reached, the script deploys without waiting, so a broken
server never blocks the fix.

## Backups

`backup.sh` writes a Postgres dump and a tarball of the server's blob folder
to `.corral/backups/` (or `CORRAL_BACKUP_DIR`), and deletes backups older
than 14 days (`CORRAL_BACKUP_KEEP_DAYS`). It runs:

- every night at 03:30, from `corral-backup.timer`
- before any deploy that changes `packages/db/migrations`, because the new
  server runs its migrations when it starts and they can't be undone. These
  files are labelled `pre-<new commit>`. If that backup fails, the deploy stops.

These copies are on the same disk as the volumes, so they cover a bad
migration but not a dead disk. Point `CORRAL_BACKUP_DIR` at another disk or
sync the folder somewhere else (set it in the units with `Environment=`).

CI also fails any change to a migration that's already on main, so the
deployed database never misses one. Schema changes always go in a new migration.

Each file name holds the time and the commit that was running when it was
taken (`postgres-<time>-<commit>-<label>.dump`). To restore, go back to that
commit first: newer code would run its migrations again on the old data.

```sh
sudo systemctl stop corral-deploy.timer   # nothing may redeploy mid-restore
git checkout --detach <commit>
docker compose build
docker compose stop web server runner
docker compose exec -T postgres pg_restore -U corral -d corral --clean --if-exists <.corral/backups/postgres-<time>-<commit>-<label>.dump
docker compose run --rm --no-deps -T --entrypoint sh server -c 'rm -rf /data/server/* && tar -C /data/server -xzf -' <.corral/backups/server-data-<time>-<commit>-<label>.tar.gz
docker compose up -d
echo <commit> >.corral/deploy/deployed
```

Fix main before starting the timer again, or it redeploys the bad commit.
