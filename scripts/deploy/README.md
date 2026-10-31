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

## Build identity

`CORRAL_BUILD_SHA` is the last commit that touched an input of the server or runner images, or the remote runner's deployment files (`build-sha.sh` has the list), not the target commit itself. A docs-only or web-only commit keeps the SHA, so the images stay identical, nothing behind the hold restarts and no runner counts as behind. So `/api/status` and Settings show the last backend commit, which can be older than `deployed`. Compose passes it as a build argument to both server and runner images. For every manual build or `up`, use `scripts/deploy/compose.sh` in place of `docker compose`: it sets the same SHA. Remote runners pull from GitHub after draining; set `CORRAL_RUNNER_AUTO_UPDATE=true` to drain automatically when the server reports a different commit. The host updater reads the runner data directory's `update-status.json` before replacing it.

## Operating it

- Logs: `journalctl -u corral-deploy -f`
- Deploy now: `sudo systemctl start corral-deploy`
- Pause: `sudo systemctl stop corral-deploy.timer`
- State lives in `.corral/deploy/`: `deployed` is the last deployed commit,
  `skipped` the last commit whose CI failed, `build-failures` the commit whose
  build is failing and how many times it has, and `backed-up` the last commit
  backed up before its migrations. Delete `deployed` to force a rebuild.
- A failed CI is checked again every tick, so re-running it is enough. A failed
  build is retried up to `CORRAL_DEPLOY_BUILD_TRIES` times (3 by default), then
  waits for a new commit; delete `build-failures` to try again sooner.
- A commit counts as deployed only when `docker compose up -d --wait` succeeds,
  within `CORRAL_DEPLOY_WAIT_TIMEOUT` seconds (180 by default; needs Compose
  2.17 or later). If not, the error goes to the journal and the next tick tries
  again. Nothing rolls back by itself. The previous images stay tagged
  `:previous` (for example `corral-server:previous`) for one deploy.
- The checkout is left detached at the deployed commit. Don't keep local
  changes in it; `.env` is untracked and is never touched.

## Recording what each deploy shipped

After `docker compose up -d --wait` succeeds and `deployed` is written, the script
waits for the new server to answer (up to `CORRAL_DEPLOY_REPORT_TRIES`
attempts, 30 by default, `CORRAL_DEPLOY_REPORT_WAIT` seconds apart, 5 by
default) and posts `POST /api/deployments` with the repository, the previous
and new commit and every commit between them with its subject (just the new
commit on a first deploy). The PM writes release notes from it (D11).
Posting the same commit twice keeps one record. If the server can't be
reached, or no project uses this repository, the script logs a warning and
the deploy still counts as done. A deploy that fails in or before `up` records
nothing.

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
- The polling loop waits for `busy` to reach zero: running PM turns count,
  queued PM turns still holding their jobs do not. Every running turn has a
  time limit, so new messages cannot extend the finishing phase. A failed poll
  doesn't end the wait; `CORRAL_DEPLOY_HOLD_FAILURES` in a row (8 by default,
  about two minutes) mean the server is broken, and the deploy goes ahead.
- The hold is in memory, so the new server starts without it. If the deploy
  fails, the script lifts it (`DELETE /api/update-hold`). Either starts queued PM turns.

Images are built before the hold, so the wait covers only running work, not
the build. A change that only touches `web`, or nothing in an image, deploys
straight away. If the
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
  It doesn't need the server running, so a broken server can still be fixed.

It takes the deploy lock, so the nightly run waits for a deploy in progress (up
to `CORRAL_BACKUP_LOCK_WAIT` seconds, 7200 by default). It refuses to start with
less than `CORRAL_BACKUP_MIN_FREE_MB` free (2048 by default). Below that, pre-deploy
backups fail too, so deploys with migrations stop until space is freed. Files that change
while the blobs are read are kept as they were, with a warning in the log.

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
scripts/deploy/compose.sh build
docker compose stop web server runner
docker compose exec -T postgres pg_restore -U corral -d corral --clean --if-exists <.corral/backups/postgres-<time>-<commit>-<label>.dump
docker compose run --rm --no-deps -T --name corral-restore --entrypoint sh server -c 'rm -rf /data/server/* && tar -C /data/server -xzf -' <.corral/backups/server-data-<time>-<commit>-<label>.tar.gz
scripts/deploy/compose.sh up -d --wait
echo <commit> >.corral/deploy/deployed
```

Fix main before starting the timer again, or it redeploys the bad commit.
