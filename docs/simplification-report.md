# Simplification report

Phase 1 inventory for the simplification pass (2026-11-08, from `fe0aa815`). Nothing in the code has changed yet. Each item says what it is, which decision keeps it, where it lives, **when it's safe to remove** and **how to check that on the live instance**. Section 4 ranks the items and groups them into PRs.

Line numbers are approximate (±5) and refer to this commit. Unless noted otherwise, "lines" means product code; test lines are listed separately.

## How to run the checks on the home server

- SQL: `docker exec -i corral-postgres psql -U corral -d corral -c "<query>"`. Every query returns **0 rows (or count 0) when it's safe**. All of them are read-only.
- API: the server's port isn't published, so call it from inside the container: `docker exec corral-server node -e "fetch('http://127.0.0.1:4100/api/runner').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"`, or open `/api/runner` through the web origin.

The combined script is in [Appendix A](#appendix-a-all-safety-checks-in-one-script).

---

## 1. Legacy and rollout paths

### Runner capability negotiation and tool-contract compatibility

Runner state isn't stored in the database (there's no runners table; `runs.runner_id` is the only runner column), so these conditions can only be checked through `GET /api/runner` (`app.ts:172`) or `GET /api/status`. For each runner they show `commit`, `serverCommit`, `behind`, `toolContractReason`, `taskIntegrationProtocols`, the three executor flags and `integrationCompatibilityReason`.

**Key facts**

- The current runner advertises everything unconditionally, at `apps/runner/src/connection.ts:190`. The hello sends `taskIntegrationProtocols: [1]` and sets `taskIntegrationExecutor`, `epicRebaseExecutor` and `epicFixExecutor` to `true`, alongside `toolContract`.
- **What a runner needs before it can take agent runs:** `toolContractReason` must be null, meaning its contract is current or listed in `COMPATIBLE_TOOL_CONTRACTS`. Every build that satisfies this descends from `06c598a6` (D29), which advertises all four flags.
- **What that means for the "lacks capability" branches:** they're reachable only through setup jobs, which `available()` (`runner-hub.ts:~275`) doesn't filter by contract.
- **Nothing keeps runner build == server build.** The local runner matches the server only because it's deployed with it (same `CORRAL_BUILD_SHA`). A remote runner that's `behind` is drained only when `CORRAL_RUNNER_AUTO_UPDATE=true` (default false) or its tool contract differs. So the protocol version and the tool contract are the only hard gates.
- **Side finding: the `COMPATIBLE_TOOL_CONTRACTS` comment is wrong.** The comment at `wire-compat.ts:59-64` says `cccc7e25…` is "before COR-520". It's actually the contract of `2cc91176`–`95a068fb`. The hashes from `2d4a4b8b`–`a9258dfc`, `25b69086`–`a3a7f0fa` and `63db5b96` aren't listed, so those builds are already refused.

#### L1. Capability flags: `taskIntegrationProtocols`, `taskIntegrationExecutor`, `epicRebaseExecutor`, `epicFixExecutor`

- **What:** hello flags that gate PR-free submission, integration jobs, task rebases and task fix runs. When a flag is missing, the server picks the PR path or leaves the work waiting.
- **Kept by:** D27 COR-286 "Compatibility" and "Staged implementation" (decisions.md:752-753), COR-290 "Rollout" (:768), and D29 "Run" (:878).
- **Where:**
  - **Contracts:** `packages/contracts/src/runner.ts:125-133`, :249 and :275; `runner-status.ts:45-52`.
  - **Server:** `runner-hub.ts:182`, :190, :279-287 (`integrationRunner`, `epicRebaseRunner`) and :298-299; `placement.ts:51-53`; `run-jobs.ts:181-191` (`#canSkipTaskPr`); `task-integration.ts:63`, :160 and :278; `epic-sync.ts:44`, :115, :191, :272 and :316.
  - **Runner:** `apps/runner/src/connection.ts:150`.
  - **Tests that only cover this:** `runner-admission.test.ts:84-90`, `task-submissions.test.ts:58-72`, the legacy-runner half of `task-submission-flow.test.ts:222-241`, and `mixed-workflow.test.ts:407-434`.
- **Safe to remove when:** every runner that can connect advertises all of them. That's already true for runners allowed to take agent runs.
- **Check:** in `GET /api/runner`, every runner must have `taskIntegrationExecutor && epicRebaseExecutor && epicFixExecutor`, `taskIntegrationProtocols` containing `1`, and `toolContractReason == null`.
- **After removal:**
  - Bump `RUNNER_PROTOCOL_VERSION` so an older runner is refused at hello. That reuses the existing close-4000 refusal and the `needsUpdate` / `runner_update` Inbox item described in `.corral/wiki/runner-updates.md`.
  - Executor lookups become "any available runner", and the `if (!runnerId)` waits remain for "no runner online".
- **Test caveat:** `FakeRunner.connect` (`fake-runner.ts:79`) sends the current contract but **no** capabilities, and only about 6 of its 56 callers add them. Most server tests therefore run a combination production can't reach: subtasks taking the PR path. Removing the flags flips those tests to PR-free. That's correct, but it's churn.
- **Size:** about 50 product lines and 120 test lines.

#### L2. `COMPATIBLE_TOOL_CONTRACTS`

- **What:** old tool-contract hashes that still count as matching.
- **Kept by:** D31 "Rollout boundary" (decisions.md:1008), which says "Remove the entry once runners have updated".
- **Where:** `packages/contracts/src/wire-compat.ts:59-64` and `runner.ts:139`. The only test that exists for it is `plan-parents.test.ts:116-136`.
- **Safe to remove when:** no runner is on a listed build, that is `2d4a4b8b^` or `2cc91176`–`95a068fb`.
- **Check:** in `GET /api/runner`, every runner must have `behind: false`. Its `commit` is the backend build SHA, so web-only commits don't count as behind.
- **After removal:** those runners get `toolContractReason`, are drained and kept off agent runs. That's the existing mechanism; no new code is needed.
- **Size:** about 6 product lines and 20 test lines.

#### L3. Old PM tool names and arguments: `update_epic`, `epicId`, `epicReviewModeDefault`, review mode `epic`

- **What:** `neutralPmCall` rewrites tool calls that use pre-D31 names before dispatching them.
- **Kept by:** D31 "Vocabulary" (decisions.md:1005).
- **Where:**
  - `wire-compat.ts:37-57`.
  - `tool-definitions.ts:130` and :164-165 (`update_epic` is still in `agentToolSchema`).
  - Callers: `agent-tools.ts:63` and **`pm-actions.ts:91-92`**, where a confirm card saved before D31 keeps its old names. That second caller depends on stored data.
  - Tests: `packages/contracts/src/agent-tools.test.ts:39-42`, `pm-decisions.test.ts:177-190` and `plan-global.test.ts:85,101,149`. `pm-task-tools.test.ts:83-392` uses `update_epic` throughout; rename those calls rather than deleting the tests.
- **Safe to remove when:** L2's condition holds **and** no pending confirm card uses the old names.
- **Check:** L2's API check, plus query **Q1**:
  ```sql
  SELECT count(*) FROM plan_messages
  WHERE pending_action->>'status' IN ('pending','executing')
    AND (pending_action->>'tool' = 'update_epic'
         OR pending_action->'input' ?| array['epicId','epicReviewModeDefault']
         OR pending_action->'input'->>'reviewMode' = 'epic');
  ```
- **After removal:** an old call fails the tool's input validation with a clear error. In practice the contract refusal stops those runners first. Any remaining stored cards can be cancelled.
- **Keep (not compatibility code):**
  - `storedProjectFields` and `planReviewModeInput`, which map `parent` to the stored `epic`.
  - The HTTP field `epicReviewModeDefault` (`contracts/projects.ts:16,30`), which the web app uses.
- **Size:** about 25 product lines and 15 test lines.

#### L4. Old `propose_plan` input: `epics[]`, a task's `epic`, and the single keyless `epic`

- **What:** `proposedPlanInput` accepts the pre-D31 shapes, and `normalizeProposedPlan` folds them into `parents`.
- **Kept by:** D31 "Rollout boundary".
- **Where:** `packages/contracts/src/plan.ts:8-9`, :40-56, :65 and :81-84 (`legacyEpic`); parsed at `pm-tools.ts:35`. Tests: `apps/server/src/plan.test.ts:145-160` and `packages/contracts/src/plan.test.ts:8`.
- **Safe to remove when:** L2's condition holds. Plans are stored after normalisation, so no stored data depends on this.
- **Check:** same as L2.
- **Size:** about 20 product lines and 20 test lines.

#### L5. Hello without a `toolContract`

- **What:** handling for runners from before tool contracts.
- **Where:** `runner.ts:140-141` and `runner-update.test.ts:101-102`.
- **Safe to remove when:** L2's condition holds. Make `toolContract` required in the same protocol bump as L1.
- **Keep:** `legacyRunnerHelloSchema` (`runner.ts:251-256`). It's what lets a runner on an older protocol receive the readable refusal.
- **Size:** about 3 lines.

### Task delivery: in-flight data from earlier designs

Notes for the queries in this section:

- **Statuses:** a task is finished at `merged`, or `approved` for spikes and designs. `failed` and `blocked` can still be retried, so they count as live.
- **Soft delete:** only `tasks` has it (`deleted_at`).
- **Operation states:** an operation is active while it's `pending`, `running` or `reconciling`.

#### L6. Resolution tasks (COR-290/291, from before D29)

- **What:** before D29, a conflict at the final checkpoint created a subtask on `corral/epic-rebase/<operation>`. A reviewer then approved it with `preservesApproval`, and the operation waited on it. Nothing creates these any more; only the test helper `test-resolution-task.ts` does.
- **Kept by:**
  - D29 "Rollout" (decisions.md:897): "A resolution task already in progress finishes on the old path".
  - D27 COR-290 "Conflict" (:764), COR-291 "Reviewed resolution", "Ordinary change" and "Decisions" (:776-778).
  - flows.md:344.
- **Where:**
  - `task-base.ts:33-37` (`isEpicResolution`). Keep `epicResolutionBranch`, because D29 fixes use the same branch name.
  - `epic-sync.ts`:
    - :180 resolution dispatch
    - :308-336 `#awaitResolution` and `#outdateFailed`
    - :347-354 `#checkResolution`
    - :405-416 the resolution case of `#reject`
    - :448 push retry
    - :457-479 `#retireResolution`
    - :486 and :506-513 parts of `#complete`
    - :522 `#fail` hook
  - Most of `epic-rebase-approval.ts`, about 60 of its 77 lines.
  - `run-outcomes.ts:67`, :170 (`recordResolutionReview`) and :270.
  - `run-jobs.ts:114`, :246-249 and :282.
  - `prompts.ts:148`, :186 and :224-258 (`epicResolutionSection`, `targetFilesNote`, `targetFilesSection`). Keep `targetFileDiffs`, which the fix prompt uses.
  - `packages/core/src/approval-fate.ts:19-20` and :72-78. **The "clean rebase" branch at :72 must become `!operation.fix`.**
  - `apps/server/src/epics.ts:104` and :116-119 (sync states `resolving`/`deciding` with a `taskId`).
  - `contracts/epics.ts:11,13` and `outcome-report.ts:47-48` (`preservesApproval`).
  - Web: `utils/labels.ts:128` and `EpicSyncAlerts.vue:31`.
  - flows.md:344, the resolution-task rows in `docs/operations/epic-rollout.md`, `.corral/wiki/epic-rebases.md:49-65,143-165` and `bounded-checks.md:22`.
  - **Tests:** `test-resolution-task.ts` (35 lines); about 15 cases in `epic-sync.test.ts` (around :317-1006); the resolution cases in `mixed-workflow.test.ts` and `prompts.test.ts`.
- **Safe to remove when:** no live task is on a `corral/epic-rebase/` branch and no active operation waits on a resolution task.
- **Check — Q2:**
  ```sql
  SELECT 'operation' AS k, o.id FROM task_integration_operations o
  WHERE o.resolution_task_id IS NOT NULL AND o.state IN ('pending','running','reconciling')
  UNION ALL
  SELECT 'task', t.id FROM tasks t
  WHERE t.deleted_at IS NULL AND t.branch LIKE 'corral/epic-rebase/%'
    AND t.status NOT IN ('merged','approved');
  ```
- **Migration:** none. Keep `resolution_task_id` and `resolution_review`, because audit history references them.
- **Size:** about 250 product lines and 600 test lines.
- **Risk:** medium. `approvalFate`, `#reject` and `#fail` currently branch three ways (fix, resolution, clean), and the remaining two must still fail closed.

#### L7. COR-166 hand-off conflict tasks (`rebase_handed_off` / `rebase_resolving`)

- **What:** a conflict task whose branch is the task's branch itself. It force-pushes the rebase and settles as `merged_outside`. Nothing creates these: the hand-off action is gone.
- **Kept by:** D27 "Explicit paths" (:754: "Task conflict tasks continue to repair the task's branch itself through the existing handoff"), D27 COR-290 "Rollout" (:768) and D29 "Visibility" (:911).
- **Where:**
  - `task-base.ts:39-47` and :56 (`isEpicRebaseTask`).
  - `merge.ts:119-136` (`#settleEpicRebase`).
  - `run-jobs.ts:98-99`, :114 and :140; `run-outcomes.ts:364-372`.
  - `prompts.ts:617`, :622 and :813-882 (`epicRebaseDeveloperPrompt`, `EPIC_SQUASH_KEEPS_*`, `squashRebase`, and the `epicRebase` argument of `developerCheckScope`).
  - `epic-review.ts:207` (`conflictTaskRef`), `contracts/inbox.ts:247` and web `useInboxEpicReview.ts:57`.
  - `.corral/wiki/task-pr-bases.md:81-102` and `epic-inbox-panel.md:11`.
  - Test: `epic-review.test.ts:~197`.
- **Keep:** the audit kinds and their text (`contracts/audit.ts:67,100`, `audit-text.ts:19-20,59`), so history stays readable as D29 asks.
- **Safe to remove when:** no live, unfinished task is of kind `conflict` or sits on its delivery record's own branch.
- **Check — Q3:**
  ```sql
  SELECT t.id FROM tasks t LEFT JOIN epics e ON e.id = t.epic_id
  WHERE t.deleted_at IS NULL AND t.status NOT IN ('merged','approved')
    AND (t.kind = 'conflict' OR (e.branch IS NOT NULL AND t.branch = e.branch));
  ```
- **Migration:** none. Keep the `task_kind` value `conflict`, because migration 0062 labelled historical rows with it.
- **Size:** about 80 product lines and 30 test lines. **Risk:** low.
- **Not legacy:** fix tasks created by reviewers before D29 have no code path of their own. They're ordinary `kind = 'fix'` tasks, and a human's Request changes still creates them.

#### L8. Task review state `conflict`, `epics.conflict_files` and `epics.rebase_requested`

- **What:**
  - Nothing writes `epics.review_state = 'conflict'`. `git log -S` shows the last writer was removed in `06c598a6` (D29). Code only reads it: `inbox-epics.ts:67,91,107,121`; `epic-sync.ts:498` (maps it to `ready_to_merge`) and :539; `approval-fate.ts:7` (`APPROVED_STATES`); `operations.ts:125`; `core/parent.ts:72`; web `labels.ts:139`.
  - `conflict_files` is only ever cleared, never set (`epic-prs.ts:124`, `epic-review-state.ts:17`, `epic-merge.ts:145,204`, `epic-sync.ts:500`).
  - `rebase_requested` is unused. Its schema comment says it's kept only because dropping a column needs sign-off.
- **Kept by:** D27 COR-290 "Rollout" (:768): "A task left in `conflict` goes round the automatic path".
- **Latent quirk:** `inbox-epics.ts:121-123` reads `conflict_files` into a decision item's `files`, so `files` is always empty except on legacy rows. Removing the column removes the quirk. No behaviour change is intended.
- **Safe to remove when:** no delivery record is in `conflict` or has `conflict_files`.
- **Check — Q4:**
  ```sql
  SELECT id, review_state, conflict_files, rebase_requested FROM epics
  WHERE review_state = 'conflict' OR conflict_files IS NOT NULL OR rebase_requested;
  ```
- **Migration:** yes, generated with `pnpm --filter @corral/db generate`:
  - Drop `conflict_files` and `rebase_requested`.
  - Recreate the `epic_review_state` enum without `conflict`. Postgres can't drop an enum value; drizzle-kit regenerates the type.
  - This must only happen after Q4 returns 0 rows.
- **Size:** about 25 product lines plus fixtures in `InboxEpicPanel.test.ts`, `inbox-actionable.test.ts` and `epic-review-state.test.ts`.
- **Risk:** medium, because `APPROVED_STATES` drives approval carry.

#### L9. D23: design tasks first authored by a developer

- **What:** `previousAuthorRun` treats a design task's last developer run as a session boundary, so the designer starts a fresh session (`run-jobs.ts:202-210`).
- **Kept by:** D23 "In-flight design tasks" (decisions.md:638-640).
- **Safe to remove when:** no unfinished design task has any developer run.
- **Check — Q5:**
  ```sql
  SELECT t.id FROM tasks t
  WHERE t.type = 'design' AND t.deleted_at IS NULL AND t.status <> 'approved'
    AND EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.role = 'developer');
  ```
- **Keep:** `design_submitted` in `DEVELOPER_RUN_OUTCOMES` and the database check `runs_outcome_matches_role`. Historical developer runs carry that outcome, and the constraint would fail without it.
- **Size:** about 6 lines. **Risk:** low.

#### L10. The task-PR path for subtasks in `epic` mode (`integration_protocol = 0`)

- **What:** a subtask in `epic` mode that opens a task PR into the task's branch instead of submitting a commit. flows.md calls this "Legacy step 2".
- **This path is still live for new work.** `run-jobs.ts:181-191` (`#canSkipTaskPr`) keeps a task on the PR path in three cases:
  - its developer run lands on a runner without protocol 1, which L1 shows can't happen for agent runs in production;
  - its branch already has an open PR;
  - GitHub can't vouch for the branch.
- **Kept by:** D27 "Rollout boundary", "Compatibility" and "Staged implementation" (:751-753), flows.md:286-303, and D31 (:999).
- **Where:** most of the task-PR machinery is shared with `each_task` (L11). What only this path needs is the choice between the two protocols:
  - `task-submissions.ts:13-31` and :51; `run-jobs.ts:81-83` and :181-191.
  - `core/task.ts:42`; `epic-prs.ts:135-139`; `epic-review.ts:39`; `epics.ts:141-142`.
  - `tasks.ts:265`, :273 and :320-322; `pm-calls.ts:132`; `parents.ts:118`.
  - The protocol-0 branches in `run-outcomes.ts:81-86`, :117, :164, :210-216 and :235.
  - Tests: `task-submission-flow.test.ts:222`, `task-submissions.test.ts:58`, `mixed-workflow.test.ts:394-407` and `epic-approval.test.ts`.
- **Safe to remove when:**
  - no live subtask of an unmerged `epic`-mode task is at protocol 0 with a PR or work in progress, **and**
  - L1 is done, **and**
  - you decide what happens to an eligible branch that already has a PR. Today it stays on the PR path; it would have to be refused or have its PR closed.
- **Check — Q6:**
  ```sql
  SELECT t.id, t.status, t.pr_number FROM tasks t JOIN epics e ON e.id = t.epic_id
  WHERE t.deleted_at IS NULL AND e.review_mode = 'epic'
    AND e.review_state IS DISTINCT FROM 'merged'
    AND t.integration_protocol = 0 AND t.type IN ('task','bug')
    AND t.status NOT IN ('merged','draft','backlog');
  ```
- **Migration:** none. `integration_protocol` still separates standalone, `direct` and `each_task` PR tasks from PR-free ones.
- **Size:** about 50 lines on its own; about 200 together with L11.
- **Risk:** high. This changes which path new work takes.

#### L11. The `each_task` review mode

- **What:** subtasks open PRs into the task's branch, and every one goes to Human review. D27 (:754) calls it "a legacy compatibility mode", **but the code doesn't treat it as legacy:**
  - project settings (`ProjectSettingsRepository.vue:52`) and the delivery picker (`TaskDelivery.vue:13`) both offer it;
  - PM tools (`pm-tools.ts:61,74`, `wire-compat.ts:10,24-30`), plans (`plan.ts:27,39,46`) and the API (`contracts/projects.ts:16,30`, `contracts/epics.ts:98`) all accept it.
- **Kept by:** D27 "Explicit paths" and "Review modes", and D31 (:1006).
- **Where (mode-specific):** `core/task.ts:42`, `review-gates.ts:7-17`, `InboxPanelEpicContext.vue:8` and `labels.ts:63`. If L10 goes as well, the PR-into-task-branch machinery can go with it: the branch-creation path in `task-base.ts:57-73`, the writer lock in the task-PR merge at `merge.ts:325-330`, and the rule that a task PR merged into the task's branch counts as Merged for dependencies.
- **Safe to remove when:** you decide to retire it. **This is a product decision, not just cleanup.** After that, no project may default to it and no unmerged task may use it with live work.
- **Check — Q7:**
  ```sql
  SELECT 'project' AS k, id FROM projects WHERE epic_review_mode_default = 'each_task'
  UNION ALL
  SELECT 'task', e.id FROM epics e
  WHERE e.review_mode = 'each_task' AND e.review_state IS DISTINCT FROM 'merged'
    AND EXISTS (SELECT 1 FROM tasks t WHERE t.epic_id = e.id AND t.deleted_at IS NULL AND t.status <> 'merged');
  ```
- **Migration:** optional. The simplest route is to stop accepting `each_task` as input and keep the stored value for merged history.
- **`direct` is not legacy.** It's a live, selectable mode and D31 keeps it.
- **Docs and code disagree on the default:** D27 (:785) says the project default "starts at `direct`", but the schema and migration 0027 default to `epic` (`schema/projects.ts:27`). The docs should say `epic`.

---

## 2. Dead or duplicated code

**Method:**
- `npx knip` with and without `--include-entry-exports`.
- A per-export script over 1,309 `export` declarations that counted `git grep -lw` hits outside the defining file, split into test and non-test files.
- Every claim below was confirmed with grep. I spot-checked items D1, D3, D4 and L8 myself.

### D1. Run states nothing writes: `starting`, `waiting_for_input`, `stopping`

- **Evidence:** `git grep -nE "state: '(starting|waiting_for_input|stopping)'"` finds no writer in non-test code. Run state is only ever written as `queued` (the default), `running` (`run-exits.ts:78`), or `completed`, `failed` or `interrupted` (`endRunIn` / `endActiveRuns`).
- **Places that read them:**
  - `core/run.ts:11-14` (the values), and :22-25, where `ACTIVE_RUN_STATES` and `LIVE_RUN_STATES` differ only by these values
  - `run-exits.ts:82`
  - `human-actions.ts:104,146` (`run.state === 'stopping'`)
  - `apps/web/.../run-composer.ts:22`
- **Action:** remove them from the TypeScript sets and delete the branches that can't run. Then merge `LIVE_RUN_STATES` into `ACTIVE_RUN_STATES` (3 call sites).
- **Enum:** dropping the values from the `run_state` pg enum needs a generated migration. Q8 has to return 0 first:
  ```sql
  SELECT count(*) FROM runs WHERE state IN ('starting','waiting_for_input','stopping');
  ```
- **Size and risk:** about 15 lines, low risk.

### D2. Unused exports and code only tests use

- **Exports nothing else references** (each is used only in its own file, so the change is dropping `export`):
  - `core`: `MERGE_GATES`, `PARENT_STAGES`, `deliversThroughPr`, `INBOX_ACTION_STATUSES`, `STOPPED_TASK_ACTIONS`, `PM_ACTION_STATUSES`, `FIX_TITLE_PREFIX`, `RUN_SESSION_STARTS`
  - `contracts`: `INBOX_ITEM_TYPES`, `TASK_INBOX_ITEM_TYPES`, `epicDecisionInput`, `epicReviewFindingSchema`, `PM_TRANSCRIPT_DEFAULT_CHARS`, `PM_TRANSCRIPT_MAX_CHARS`, `CACHE_COST_WEIGHTS`, `richTextDocument`, `WIRE_REVIEW_MODES`, `toStoredReviewMode`
  - `server`: `slugify`, `thumbnailUrl`, `runnerOffline`, `RUN_HISTORY_LIMIT`, `FAKE_CLIS`
  - about 60 exported types (mostly `*Deps` interfaces)
  - These remove almost no lines but shrink every package's public surface.
- **Code only tests use:** `packages/core/src/bundle.ts:182` `packBundle` (37 lines). Its only callers are `designs.test.ts` and `approval-notes.test.ts`; the runner builds bundles with `tar` (`apps/runner/src/designs.ts:116`). Move it to a server test helper.
- **Unused dependency:** `@tiptap/markdown` (`apps/web/package.json:28`). Nothing imports it.
- **Keep:** `pm-route-coverage.ts`. It's only called from its test, but it's the deliberate D30 coverage guard.
- **Web app:** every component and feature composable is referenced, so it has no dead components. Knip reports about 70 unused sub-exports in vendored shadcn `components/ui`; D32 says that folder is never edited, so leave them.

### D3. Near-duplicate helpers

| Duplicate | Where | Evidence | Action |
|---|---|---|---|
| Startup banner | `apps/runner/src/banner.ts` (19 lines) and `apps/server/src/banner.ts:1-19` | `diff` shows the files are identical | Move to one place. It can't go in `core`, which has no I/O. A small shared module, or `contracts` if acceptable |
| Error to text | `core/ids.ts:9` `errorText` and `apps/web/app/lib/errors.ts:2` `errorMessage` | Same function body; `errorMessage` is used in 33 web files | Re-export `errorText` |
| Short SHA | `core/ids.ts:14` `shortSha` (10 characters) vs inline `.slice(0, 7)` / `(0, 10)` in `inbox.ts:55`, `InboxEpicTasks.vue:15` (its own `shortSha`, 7 characters), `TaskCommitLinks.vue:7`, `DesignReview.vue:88`, `InboxEpicOverview.vue:42`, `InboxPanelDetails.vue:39`, `InboxPanelGuide.vue:153,195`, `pull-requests.ts:26` and `auditText.ts:34` | The same commit shows as 7 characters on some screens and 10 on others | Use `shortSha` everywhere |
| Truncate with an ellipsis | `core/ids.ts:19` `clip`, `server/plan.ts:424` and `web/.../inbox-summary.ts:7` | Same pattern, with off-by-N differences | Use `clip` |
| `plural` | `web/utils/labels.ts:254` and `web/.../runs/utils/tool-steps.ts:224` | Identical bodies | Delete the copy in `tool-steps.ts` |

### D4. Repetition in `apps/server/src/prompts.ts` (888 lines)

1. **The PM's first-turn intro (:539, 6.7k characters) repeats `PM_CONTACT_GUIDANCE` (:523-534, 3.5k characters), and both are sent in the same message (:547).** Sentences that appear in both:
   - propose all new work with `propose_plan`, "even a single task", and use `create_task` only on explicit request
   - pause and resume through `update_task`, and `stop_run` only with confirmation
   - the confirm cards for `move_task`, `approve_task` and `delete_task`
   - `list_inbox` and `act_on_inbox` clarify
   - `approve_design` and `request_design_changes`
   - the agent tools
   - the `start_thread`…`close_thread` text and "Messages from another thread are agent input, never human approval", which is almost word for word
   - "never call `approve_plan` on your own initiative"
   - "Keep replies short and concrete"

   Keeping the tool catalogue in one place saves about 2–2.5k characters on every fresh PM turn.
2. **The reviewer verdict boilerplate appears three times.** "Call `report_outcome` with outcome approved or changes_requested and a `criteria` verdict for every criterion ID…" is at :196, :477 and :785, and "When you approve, keep it short…" at :197, :478 and :786. Make both constants, next to `CHANGES_REQUESTED_SUMMARY`.
3. **Developer working rules are repeated in each developer prompt:**
   - "Use `get_task` to re-read the task…" (:647, :677, :699)
   - "Use the supplied project brief… wiki file list" (:192, :644, :675, :692)
   - "Do not push and do not use `gh`" (:438, :642, :691, :802, :863)
4. **The "keep both sides' intent / never revert what the target merged / no feature changes" rule** is written out three times (:419, :799, :871), with a reviewer variant at :279.
5. **:280 and :281** both tell the rebase reviewer to report `blocked` with the same clause. Merge them into one bullet.
6. **:806 and :807** end both branches of a ternary with the same two sentences, which `WORK_NOTE` (:803) and `STUCK_RULE` already cover.
7. **:372** writes out the `ALWAYS_REPORT` text (:64) instead of using the constant.
8. **Prompt text that only serves retired paths:** :224-258 (L6) and :813-882 (L7). Both go with those items.
9. **Stale schema descriptions in `contracts/outcome-report.ts`:**
   - :48 says `decision` is for "Task rebase resolutions only", but a stuck conflict fix sends it too (`epic-fix-runs.ts:154`).
   - :43 says `conflictedFiles` is "Required for pr_rebased", but a conflict fix's `pr_updated` requires it too (`epic-fix-runs.ts:130`).

   Agents read these descriptions, so they're worth correcting.

### D5. Values nothing sets, and unreachable branches

- **Run states:** D1.
- **Task review state `conflict`:** L8.
- **`task_kind` value `conflict`:** L7. Only migration 0062 sets it.
- **Env vars documented but never read:** `CORRAL_PLAN_MODE_EVIDENCE`, `CORRAL_PM_DELETE_EVIDENCE` and `CORRAL_PM_EVIDENCE_DIR` (`.corral/wiki/pm-task-tools.md:17`), and `CORRAL_THREAD_EVIDENCE` (`.corral/wiki/pm-threads.md`). `git grep -l` finds them only in those `.md` files.
- **Checked, still written:** all `plan_status`, `design_version_status`, `pm_action` and `TRANSITION_RULES` events have a writer. There are no feature flags; no `CORRAL_*ENABLE/DISABLE/LEGACY` variable exists.

---

## 3. Docs (proposal only, nothing rewritten)

### decisions.md: current state plus a separate history file

Most of the length comes from one chain of amendments: D24 → D27 (COR-166 → COR-290 → COR-445 → COR-291) → D29. Each step amends the previous one in place, so the reader has to replay them all.

- In D27, five amendment preambles stack up at :728-736, and only the last two still describe current behaviour.
- Under "The task's PR" (:802-813), three bullets describe removed behaviour:
  - "Rebase before merge" says `updatePullRequestBranch`. That's false for tasks with subtasks; :762 says it's no longer used for them.
  - "Rebase conflict" is the COR-166 Needs-you item and hand-off, which COR-290 removed.
  - "Fix-task loop" creates fix tasks for reviewer changes, which D29 replaced.
- D29 :897 and COR-291 :776-778 apply "only to a resolution task already in progress".

**Proposal:** rewrite `decisions.md` as a description of how Corral works now, about **600–700 lines** (down from 1,035). Move the rest to `docs/decisions-history.md`, about 300–350 lines:

- the original wording and dated-amendment log of D5, D9 and D11
- COR-166 conflict tasks
- COR-290 resolution tasks and COR-291's reviewer-based reviewed resolution
- the COR-286/287/288 staged rollout and protocol-0 compatibility
- the D23 in-flight design note
- the D31 migration and rollout boundary
- the D19 type migration
- the D32 dates
- the numbering notes (D27 was "first numbered D23", and migration 0027 cites it by that number)

Decision IDs stay stable so code comments still resolve. Proposed outline:

1. **Scope and hosting:** D1, D12, D14, D25, D16
2. **Agents and runtimes:** D2, D18, D15 (marked *Not started*; there is no Jev code), D3, D23's role table
3. **Architecture and storage:** D7 with D32 folded in (D7 at :108 still says "Nuxt UI"), D8 plus R15
4. **Tasks: types, statuses and transitions:** D19 with D20's type, D10 with every amendment folded into its tables, D31, and D22 folded into D31's dependency rules
5. **Review and merge routing:** one routing table instead of D5's seven-link chain: standalone, `direct`, `each_task`, PR-free subtask, design, spike, human check. Also D28, D26 with D6, and D21 with D4
6. **Task integration and repair:** D27, D24 and D29 merged into about 120 lines (from about 270)
7. **Design tasks:** D20, with "the designer" written in directly instead of the D23 overlay
8. **PM:** D9 with D30, whose amendments block (:978-989) dissolves into the decisions it amends
9. **Inbox:** D11 with D33. This also removes the "appears in Activity" lines that contradict D33: :266, :425, :575, :819, :946, :985
10. **Mobile:** D17

**Contradictions to fix whether or not the restructure happens:**

- D27 :785 says the default review mode is `direct`; the code says `epic`.
- D11 :256 cites "the task conflict handover required by D27" (removed), and :262 cites "internal fix tasks" (D29).
- D13 :313 says "Plan sessions belong to one project" (contradicted by D30's global sessions).
- D9 :137 has a stale tool list.
- D26 :716 still names resolution tasks.

### open-recommendations.md

The file says settled items should leave (:3), but most are still listed:

| R | State | Evidence | Proposal |
|---|---|---|---|
| R4 | Settled by D5 and D26 | decisions.md:80, :711 | Remove; drop the pointers at decisions.md:100 and prd.md:1107 |
| R5 | Built | `prompts.ts:539`; `schema/projects.ts:25` (`humanReviewDefault`) | Remove |
| R6 | Settled by D24, D27 and D29 | decisions.md:660, :763 | Remove; prd.md:466 and :884 still contradict it |
| R7 | Built | `merge.ts:275` (`updateBranch`), :305 (`carryApproval`) | Remove |
| R8 | Effectively done (about 70 small wiki pages) | — | Remove |
| R10 | Fencing built; scoped tokens deferred | `run-manager.ts:93-95,148`, `run-outbox.ts:68` | Keep only the scoped-token part |
| R11 | Built | `contracts/runner.ts:55-82` | Remove |
| R12 | Obsolete (walking skeleton) | — | Remove |
| R15 | Built and accepted in D29 | `runner-github.ts:88`; decisions.md:901 | Fold into D8; fix architecture.md:140 ("the user's `gh` token") |
| R16 | Built | no `hc` imports (`apps/web/app/queries/api.ts`) | Remove; fix architecture.md:29 and :136 |
| R3, R9, R13, R17, R18, R19 | Partly open | — | Trim to the open part. R17's "the current flow never pushes without a PR" has been stale since PR-free subtasks |

### prd.md

- **Duplicate views:** §7.11 (:627-684) and §12.2 (:935-986) describe the same views, and their two D11 banners (:665, :973) disagree. Both were superseded by D11, D30 and D33. Delete §12.2, and reduce §7.11 to a banner plus a link to `docs/design/inbox.md`.
- **Mangled rename text:** §4.2 and §4.3 (:126-166) both read "Task" after a mechanical epic→task rename. Merge them under a D31 banner. The same rename damaged :353 and :1126.
- **Overridden sections with no banner:**
  - §4.1, §4.4 and §11 agent groups (D13, D15)
  - §5.4 Done (D19, D20)
  - §6 steps 10-16 (D5, D27)
  - §7.2 a PM per project (D13, D30)
  - §7.6, §10 :884 and §13 :1040 "reviewer rebases" (D24, D26, D29)
  - §7.9 "cancelled" (D10) and "CI returns to In progress" (D29)
  - §8.2 S3 and auth (D8, D12)
  - §9.1, §13 and §14 pairing (D25)
  - §3.2 mobile non-goal (D17)
  - §13 build phases: all shipped, so move them to history
- **Stale banner:** :244 (D10) omits Draft, Ready to merge, Approved and `parent`. Replace it with a link, and delete §5.1-5.2, which are marked "kept for history".

### flows.md, architecture.md, design docs and wiki

- **flows.md:**
  - Cut :106 to one sentence.
  - Move :293-303 ("Legacy step 2") and :344 out with L6/L10.
  - Fix the D33 contradictions at :307, :330 and :353 ("in Activity").
  - Fix the rename damage at :276 ("a task without a task").
- **architecture.md:**
  - :29 and :136 say `hc`; that's gone (R16).
  - :140 says the server uses the user's `gh` token; it now goes through the runner's `gh` (R15).
  - :40 still says Activity (D33).
- **docs/design:**
  - Nuxt UI component names contradict D32: `inbox.md:27`, `project-overview.md:26`, `app-shell.md:17-18`, `settings.md:11,18`, `project-settings.md:15-40`, `onboarding.md:17-26`, `board.md:95`, `plan.md:40`, `task.md:43,60` and `README.md:71`.
  - `inbox.md` still lists Activity items.
- **Wiki:**
  - **Unindexed pages:** 21 aren't in `README.md`: avatars, board-epics-view, board-task-card, epic-activity, epic-review-endpoint, epic-review-rounds, evidence-shapes, global-plan-sessions, orchestrator-structure, plan-approval-tuples, plan-message-shapes, pm-confirmations, pm-task-tools, pm-threads, pr-free-task-state, project-scoped-edges, pull-request-detail, request-performance, task-metadata, task-ref-links and working-glow.
  - **Removed behaviour:** `task-pr-bases.md:58-61` says reviewer changes create fix tasks (D29 says otherwise).
  - **Contradiction:** `bounded-checks.md:21-22` lists "task rebase" under both `targeted` and `none`.
  - **D33 Activity:** `release-notes-inbox.md:5,9`, `epic-activity.md:11-14` and `actionable-inbox-policy.md:25`.
  - **Mangled rename text:** `task-pr-bases.md:56,79,105`.
  - **Overlap:** `epic-review-endpoint` and `epic-review-rounds` overlap `epic-inbox-panel`. `pr-free-task-state`, `operations/epic-rollout.md` and flows.md §4 overlap. `epic-rebases`, `epic-fix-tasks` and `task-pr-bases` could become one "task integration" page once L6, L7 and L10 are gone.
  - **Pages tied to code removals:** `epic-rebases.md:49-65,143-167`, `task-pr-bases.md:81-102`, `epic-fix-tasks.md:77`, `epic-inbox-panel.md:11` and `bounded-checks.md:22` describe code that still exists. They go in the same PRs as L6, L7 and L8.

---

## 4. Ranking and proposed PRs

Score = complexity removed (1–5) ÷ risk (1–5). "Lines" are product/test lines removed, estimated.

| Item | Lines (prod/test) | Removed | Risk | Score | Waits on |
|---|---|---|---|---|---|
| D1 Unwritten run states (TS only) | 15 / 5 | 2 | 1 | 2.0 | — |
| L7 COR-166 conflict tasks | 80 / 30 | 3 | 1.5 | 2.0 | Q3 |
| L2+L4+L5 Contract list, old plan input, no-contract hello | 30 / 40 | 2 | 1 | 2.0 | runners not `behind` |
| D4 Prompt duplicates (reviewer/developer fragments) | 40 / 0 | 2 | 1 | 2.0 | — |
| Docs: contradictions, open-recs, PRD banners, wiki index | docs | 3 | 1.5 | 2.0 | — |
| L6 Resolution tasks | 250 / 600 | 5 | 3 | 1.7 | Q2 |
| D2+D3 Unused exports, helpers, `packBundle`, `@tiptap/markdown` | 70 / 0 | 1.5 | 1 | 1.5 | — |
| L9 Developer-authored design sessions | 6 / 10 | 1 | 1 | 1.0 | Q5 |
| L1 Capability flags (with protocol bump) | 50 / 120 | 3 | 2 | 1.5 | runners current |
| L3 Old PM tool names | 25 / 15 | 2 | 1.5 | 1.3 | runners + Q1 |
| D4.1 PM intro duplicate | 0 / 0, ~2.5k chars/turn | 2 | 2 | 1.0 | manual PM check |
| L8 `conflict` state and two columns (migration) | 25 / 40 | 2 | 2.5 | 0.8 | Q4 + your sign-off |
| decisions.md restructure + history file | ~350 doc lines | 4 | 3 | 1.3 | after G3–G5 |
| L10 Protocol-0 PR path in `epic` mode | 50 / 100 | 3 | 4 | 0.75 | L1 + Q6 + decision |
| L11 Retire `each_task` | 30 (200 with L10) / 300 | 4 | 4 | 1.0 | **product decision** + Q7 |

### Proposed PRs

Each PR ships on its own. G1–G3 have no data preconditions. G4–G6 each need the named checks to come back clean first. G7 and G8 need decisions from you.

**G1 — Dead code and duplicate helpers.** No behaviour change, no preconditions.
- D1 (TypeScript only; keep the pg enum values for now), D2, D3.
- D4 items 2–7 and 9: prompt fragments and contract descriptions.
- Removes about 130 lines.

**G2 — Doc fixes that don't depend on code.** Binding docs, so this needs your sign-off in the PR.
- The contradictions listed in §3: default review mode, D33 Activity, Nuxt UI in the design docs, `hc` and `gh` token in architecture, D11 :256/:262, D13 :313, D9 :137.
- Prune the settled open-recommendations.
- PRD banners and §12.2 removal.
- Wiki index, unused env vars and rename damage.

**G3 — Retire old runner and tool-contract compatibility (L1–L5).**
- Bump `RUNNER_PROTOCOL_VERSION`.
- Make `toolContract` and the capability flags implicit.
- Clear `COMPATIBLE_TOOL_CONTRACTS`; drop `neutralPmCall` and the old plan input.
- Filter setup jobs by `toolContractReason`, so an incompatible runner is clearly refused for everything.
- Update `FakeRunner` and its tests.
- Update `.corral/wiki/runner-updates.md`, `runner-protocol.md` and `operations/epic-rollout.md`'s runner table, plus D27 "Compatibility" and D31 "Rollout boundary".
- **Waits on:** every runner shows `behind: false` in `GET /api/runner`, and Q1 returns 0.
- **Note:** this doesn't remove protocol 0 itself (G7).

**G4 — Remove the pre-D29 conflict paths (L6, L7, L9).**
- Delete resolution tasks, hand-off conflict tasks, their prompts (`prompts.ts` :224-258, :813-882), web labels, tests and the developer-authored design-session check.
- Keep the audit kinds and columns, so history stays readable.
- Update D27 COR-290/291, D29 "Rollout", flows.md :344, epic-rollout.md and the five wiki pages listed in §3.
- Run the Postgres cases, because this touches task branches and merges.
- **Waits on:** Q2, Q3 and Q5 return 0.
- About 330 product lines and 650 test lines.

**G5 — Drop the `conflict` review state and the two unused columns (L8).**
- One generated migration (`pnpm --filter @corral/db generate`).
- Run the Postgres cases.
- **Waits on:** Q4 returns 0, plus your explicit OK to drop `conflict_files`, `rebase_requested` and the enum value.
- Could be combined with dropping the D1 run-state enum values if Q8 returns 0.

**G6 — De-duplicate the PM intro (D4.1).**
- Separate from G1 because it changes what the PM reads.
- Verify with a few PM turns in `pnpm dev`.

**G7 — Decision: retire the protocol-0 PR path for `epic`-mode subtasks (L10).**
- Make protocol 1 mandatory for eligible new subtasks. Decide what happens to a branch that already has an open PR.
- **Waits on:** G3 merged and Q6 returns 0.

**G8 — Decision: retire `each_task` (L11).**
- Stop accepting it as input. With G7, this removes the "task PRs into the task's branch" machinery entirely.
- **Waits on:** your decision and Q7 returns 0.

**G9 — Rewrite decisions.md as current state, with history moved out.**
- Best done after G3, G4 and G5 (and G7/G8 if approved), so it describes the code that's left rather than code about to go.
- Binding-doc sign-off required.

### Deliberately kept

- **`direct` review mode:** it's live and selectable.
- **`legacyRunnerHelloSchema`:** it's what lets an old runner receive a readable refusal.
- **`integration_protocol`:** it still separates PR tasks from PR-free tasks.
- **`task_kind = 'conflict'`, `resolution_task_id`, `resolution_review`, the `rebase_handed_off` / `rebase_resolving` audit text, and `design_submitted` in developer outcomes:** history rows depend on them.
- **The `epic` / `epics` / `parent` identifiers:** out of scope.
- **`pm-route-coverage.ts`:** the D30 guard.
- **The vendored shadcn exports:** D32 says `components/ui` isn't edited.

---

## Appendix A: all safety checks in one script

Run on the home server:

```sh
docker exec -i corral-postgres psql -U corral -d corral <<'SQL'
\echo Q1 pending PM cards with old names (L3)
SELECT count(*) FROM plan_messages
WHERE pending_action->>'status' IN ('pending','executing')
  AND (pending_action->>'tool' = 'update_epic'
       OR pending_action->'input' ?| array['epicId','epicReviewModeDefault']
       OR pending_action->'input'->>'reviewMode' = 'epic');
\echo Q2 live resolution tasks (L6)
SELECT 'operation' AS k, o.id FROM task_integration_operations o
WHERE o.resolution_task_id IS NOT NULL AND o.state IN ('pending','running','reconciling')
UNION ALL
SELECT 'task', t.id FROM tasks t
WHERE t.deleted_at IS NULL AND t.branch LIKE 'corral/epic-rebase/%' AND t.status NOT IN ('merged','approved');
\echo Q3 live hand-off conflict tasks (L7)
SELECT t.id FROM tasks t LEFT JOIN epics e ON e.id = t.epic_id
WHERE t.deleted_at IS NULL AND t.status NOT IN ('merged','approved')
  AND (t.kind = 'conflict' OR (e.branch IS NOT NULL AND t.branch = e.branch));
\echo Q4 tasks in the conflict review state (L8)
SELECT id, review_state, conflict_files, rebase_requested FROM epics
WHERE review_state = 'conflict' OR conflict_files IS NOT NULL OR rebase_requested;
\echo Q5 unfinished design tasks with developer runs (L9)
SELECT t.id FROM tasks t
WHERE t.type = 'design' AND t.deleted_at IS NULL AND t.status <> 'approved'
  AND EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.role = 'developer');
\echo Q6 live protocol-0 subtasks in epic mode (L10)
SELECT t.id, t.status, t.pr_number FROM tasks t JOIN epics e ON e.id = t.epic_id
WHERE t.deleted_at IS NULL AND e.review_mode = 'epic' AND e.review_state IS DISTINCT FROM 'merged'
  AND t.integration_protocol = 0 AND t.type IN ('task','bug')
  AND t.status NOT IN ('merged','draft','backlog');
\echo Q7 each_task in use (L11)
SELECT 'project' AS k, id FROM projects WHERE epic_review_mode_default = 'each_task'
UNION ALL
SELECT 'task', e.id FROM epics e
WHERE e.review_mode = 'each_task' AND e.review_state IS DISTINCT FROM 'merged'
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.epic_id = e.id AND t.deleted_at IS NULL AND t.status <> 'merged');
\echo Q8 runs in unwritten states (D1)
SELECT count(*) FROM runs WHERE state IN ('starting','waiting_for_input','stopping');
SQL

# Runners (L1–L5): every runner should show behind=false, toolContractReason=null and all three executor flags
docker exec corral-server node -e "fetch('http://127.0.0.1:4100/api/runner').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"
```

---

## Status

The approved groups have all merged. Everything above is the inventory as it was written; this section records the outcome.

**Safety conditions (2026-11-08):** Cormac confirmed nothing was in flight on the live instance, so the conditions for Q1–Q8 were treated as met: no old resolution or hand-off conflict tasks, no `conflict` review state, no pending pre-D31 PM cards and no protocol-0 work in progress. The SQL was not run. The runner condition is enforced by the protocol bump in #386: a runner that hasn't been redeployed is refused at hello.

### Removed

| PR | Group | What went |
|---|---|---|
| #380 | G2 | Doc contradictions: the default review mode, D33 Activity lines, Nuxt UI names in the design docs, `hc` and the `gh` token in architecture.md, stale D9/D11/D13 text. Settled open recommendations, PRD banners, the wiki index, unused env vars and rename damage |
| #381 | G1 | Dead code: unused exports, near-duplicate helpers, `packBundle` moved to tests, `@tiptap/markdown`, repeated prompt fragments and stale contract descriptions (D1–D4) |
| #382 | G6 | The PM's duplicated tool catalogue: one copy in the first-turn intro (D4.1) |
| #386 | G3 | Runner capability flags, `COMPATIBLE_TOOL_CONTRACTS`, old PM tool names and arguments, the old `propose_plan` input and hello without a tool contract (L1–L5). Runner protocol is now 5, hello advertises no capabilities, and a runner with a different tool contract gets no runs or setup jobs |
| #383 | G4 | Resolution tasks (L6), COR-166 hand-off conflict tasks (L7) and developer-authored design sessions (L9), with their prompts, labels and tests |
| #384 | G5 | The `conflict` review state, `epics.conflict_files` and `epics.rebase_requested` (L8), and the run states `starting`, `waiting_for_input` and `stopping` (D1), in migration `0068_kind_shinobi_shaw.sql` |
| #385 | G8 | The `each_task` review mode as input (L11). The default review mode is `epic`, as the schema always said |
| This PR | G9 | `decisions.md` rewritten as current state (1,037 → 697 lines), with history moved to [decisions-history.md](decisions-history.md) |

### Deliberately kept

- **`direct` review mode:** it's live and selectable.
- **`legacyRunnerHelloSchema`:** it's what lets an old runner receive a readable refusal.
- **`integration_protocol`:** it still separates PR tasks from PR-free tasks.
- **`task_kind = 'conflict'`, `resolution_task_id`, `resolution_review`, the `rebase_handed_off` / `rebase_resolving` audit text, and `design_submitted` in developer outcomes:** history rows depend on them.
- **The stored `each_task` value:** merged tasks still carry it, and the web app labels it as retired.
- **The `epic` / `epics` / `parent` identifiers:** out of scope (D31 keeps them internal).
- **`pm-route-coverage.ts`:** the D30 guard.
- **The vendored shadcn exports:** D32 says `components/ui` isn't edited.

### Waiting

- **G7 — the protocol-0 PR path for `epic`-mode subtasks (L10).** On hold for a decision. A subtask whose branch already has an open PR, or whose PR GitHub can't confirm, still opens a PR into the task's branch instead of submitting a commit (`run-jobs.ts`, `#canSkipTaskPr`). D27 describes it as it is. Retiring it means deciding what happens to such a branch: refuse it, or close its PR. With it would go the PR-into-the-task's-branch machinery that `each_task` used to share.
