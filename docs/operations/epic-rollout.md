# Operating PR-free epics

For whoever runs a Corral deployment. It covers switching on PR-free epic tasks and automatic epic rebases, what to do with runners, how to tell what an epic is waiting on, and how to get a stopped one moving. The rules behind it are in [D27](../decisions.md); the walkthrough is [flows.md section 4](../flows.md).

`apps/server/src/mixed-workflow.test.ts` runs each behaviour described here against real git.

## Activating it

There is no switch and no data migration. Deploying the server and runners activates it. Migrations `0051` to `0055` add tables and columns, change two constraints, and record the current head as the approved commit of epics already holding approval. They change no branches, PRs, reviews or evidence.

1. Deploy the server. Tasks and epics keep working as they were.
2. Update every runner to the same build (`docs/runner-wsl2.md` for a remote one). A runner opts in through its hello, so an old build stays legacy-only until it's updated.
3. Nothing else. The next developer run on an eligible task selects the PR-free path.

**Don't touch active task PRs.** Don't rewrite, rebase, close or reopen them for the rollout, and don't edit `integration_protocol` by hand. An open task PR finishes on the PR path, including its revisions and rebase rounds. No background job converts anything, and existing `direct` epics stay direct. An epic can hold both kinds of task and lands as one epic PR.

Selection is permanent for a task: once it's PR-free, every later developer run needs a runner that supports it.

## Which runners do what

| A runner that advertises | Can take |
|---|---|
| Nothing (an old build) | Task PR work only. PR-free tasks are never placed on it, and a developer run it picks up on a new eligible task keeps that task on the PR path |
| `taskIntegrationProtocols: [1]` | PR-free developer and reviewer runs |
| `taskIntegrationExecutor` | The git work that integrates approved tasks into epic branches |
| `epicRebaseExecutor` | The git work that rebases epic branches |

Every current build advertises all three. The WebSocket protocol stays at version 3, so an old runner still connects. It's sent an update reason, which also appears as `integrationCompatibilityReason` in `GET /api/runner` and `GET /api/status`.

While you have a mix of runners:

- With no runner that supports protocol 1 online, a PR-free task stays unleased in its column. It isn't failed.
- With no executor online, approved tasks wait in Ready to merge, and an epic behind its target waits at its checkpoint. Neither counts as a failure, and both carry on once one connects.

## Telling the two kinds of task apart

| | Task PR (legacy) | PR-free (integrated) |
|---|---|---|
| Which tasks | Anything with a PR from before the rollout, or submitted from an old runner; all of `each_task`; `direct` epics; standalone tasks | New tasks and bugs in `epic` mode |
| In the task's properties | A link to the PR | Submitted, approved and integrated commits |
| `tasks.integration_protocol` | `0` | `1` |
| `GET /api/projects/<slug>/tasks/<number>` | `pr` is set, `submission` is null | `pr` is null, `submission` is set |
| Developer outcomes | `pr_opened`, `pr_updated`, `pr_rebased` | `commit_submitted` |
| Merged means | The PR squash-merged into the epic branch | The commit carrying its `Corral-Submission` trailer was read back from the epic branch |
| Human review | On the task | On the epic's final approval (`humanReview` and human checks are ticked there) |

A task with neither `pr` nor `submission` hasn't submitted yet, so it can still go either way. A rebase resolution task (branch `corral/epic-rebase/<operation>`) has no PR and no submission, and uses `pr_updated`; that's expected.

An epic's PR description and its review in the Inbox list both kinds together, with each task's PR or commits and its evidence.

## What an epic is waiting on

Start at the epic page. The banner and the status come from `sync` on `GET /api/epics/<id>`, and the timeline from `GET /api/epics/<id>/history`.

| You see | `sync.state` | What's happening | What you do |
|---|---|---|---|
| Rebasing onto the target branch | `rebasing` | A journaled rebase is running | Nothing |
| Resolving a rebase conflict, naming the files and task | `resolving` | A developer and reviewer are working on a private candidate. The epic branch hasn't moved | Nothing. Follow the task on the board |
| This rebase needs your decision | `deciding` | The two sides can't both hold, or a binding decision changed. The question, its alternatives and the affected changes are in your Inbox on the resolution task | Answer it in Needs you |
| Rebase stopped, with **Retry** | `failed` | Three failures on the same commits, or GitHub won't merge an up-to-date PR. `sync.error` says why | Fix the cause, then **Retry** |
| No banner, task in Ready to merge | `null` | Integration is queued or running, which `sync` doesn't show; check for an executor, then the journal below | Nothing, unless the project is paused, the kill switch is on or an update hold is set |
| Waiting for your review | `null` | The Inbox has the epic review | Approve or request changes |

Anything that holds an epic's writer lock also holds approval, task PR merges into that epic, integration review and the epic merge. That's why an approve can answer `409 epic_review_changed` during a rebase: reload, and approve the head shown now.

Pausing the project, the kill switch and an update hold all stop new writes, leaving operations where they are to carry on afterwards. Only an unknown push result is still settled, because that just reads the branch.

### Reading the journal

`docs/operations/epic-operations.sql` is a read-only query listing every active or recently failed operation, for use when the page isn't enough. An operation's state tells you how far it got:

| State | Meaning |
|---|---|
| `pending` | Written, no git work started |
| `running` | The runner is working, or a candidate is waiting for CI, a pause, or a conflict resolution (`resolution_task_id` set) |
| `reconciling` | A push was sent, or was about to be, and its result is unknown until the remote has been read |
| `succeeded` | Confirmed on the branch; `result_head_sha` is the commit |
| `failed` | Ended; `error` says why |

`The epic branch moved` and `Interrupted before a candidate was ready` aren't problems: both retry at once, and neither counts as a failure.

## Recovering

**After a restart or crash of the server or a runner: do nothing.** Every step is rebuilt from the journal and the remote on the next merge pass (within 15 seconds of a runner being online). A push that landed is recorded once, a push that didn't is retried, and a candidate cut off part-way starts again. A reviewed resolution is pushed again as the same commit. Don't push the epic branch, and don't edit the journal, to help it along.

| Stopped thing | How to resume it |
|---|---|
| Epic shows **Rebase stopped** | Fix the cause, then press **Retry**, or `POST /api/epics/<id>/sync/retry`. This restarts the failure count, and a reviewed resolution pushes its same commit |
| Task **Failed** after three integration failures | Read `error` on its operations, then choose **Retry** on its Inbox item. It goes back to its developer |
| Task **Blocked** because the epic branch is missing, or checks never finished | Restore the cause, then resolve its Inbox item the same way |
| Resolution task deleted, or the epic branch moved outside Corral | Nothing. The operation ends, its task and candidate go, and the next checkpoint starts again |
| Epic PR merge refused three times | It's back in Human review. Approving retries the merge |

**A push to an epic branch outside Corral costs its approval.** Any head Corral didn't produce from the approved head loses approval, whatever it contains, and restarts integration review and human approval. Only clean rebases and resolutions whose review validated them carry it, and CI always runs again on the new head.
