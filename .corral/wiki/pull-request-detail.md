# Pull request detail

`GET /projects/:slug/tasks/:number/pull-request` returns a task's PR, and `GET /projects/:slug/pull-requests/:number` returns any PR on the project's repository, so the task and epic panels share one fetch (`readPullRequest` in `apps/server/src/pull-requests.ts`). Both read live from GitHub through the runner's `gh`; nothing is stored.

The response is `PullRequestDetail`: title, description, base and head branches, and changed files with their additions, deletions and patch. A file's `patch` is empty when GitHub has no text diff for it, such as a binary or very large file.

The diff is capped at 20 files and 1,000 changed lines, counted as additions plus deletions in GitHub's file order. The file that crosses the line budget keeps the start of its patch, cut on a whole line, with its real counts; later files with changes are left out. Files with no changed lines, such as renames, cost nothing. `truncated` is true whenever anything was left out, `totalFiles` is the PR's full file count, and `url` is where the rest is. The cut patch's hunk header still states the original length.

Errors: a task with no PR is 404 `no_pull_request`. GitHub answering 404 is 404 `pull_request_unavailable`; any other GitHub or runner job failure is 502 with the same code and GitHub's message. An offline runner stays 503 `runner_offline`.

The prototype's `mock-api.ts` serves both routes from `pullRequestDetails` in its fixtures.
