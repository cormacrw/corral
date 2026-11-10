# Decisions: history

**Not binding.** [decisions.md](decisions.md) describes how Corral works now. This file keeps what it no longer says: when each decision was made, how it was amended, the mechanisms that were replaced or removed, and the migrations that carried the changes. Read it to understand why an old row, audit entry, column or comment looks the way it does. Don't build from it.

Until 2026-11-09, `decisions.md` was written as a log: each decision kept its original text, and later decisions amended it in place with "Amended by …" notes. That file grew past 1,000 lines, and the task-delivery rules (D24 → D27 → COR-166 → COR-290 → COR-445 → COR-291 → D29) had to be replayed to know what applied. The rewrite folded every amendment into the text it amends. The full log is in git history: `git log -p -- docs/decisions.md`.

## Numbering

- IDs are assigned in order of acceptance and never reused. Some numbers were taken when a decision was drafted, so the gaps in meaning aren't gaps in sequence.
- **D18** (Codex) was numbered D18 because D17 was already the mobile layout. **D19** (task types) and **D20** (design tasks) followed for the same reason.
- **D27 was first numbered D23.** It was renumbered when D23 went to "Designers own design tasks". Migration `0027_epic_review_modes.sql` still cites it as D23, and can't be edited because it has already run. Where an old migration, commit or comment says "D23" about review modes or task branches, it means D27.
- Ticket references (COR-…) are the Corral board tasks that made or amended a decision. Code comments cite them, so `decisions.md` keeps the ones still cited.

## When each decision was made

| ID | Accepted | Source | Later changes |
|---|---|---|---|
| D1–D11 | 2026-10-26 | PRD review (D11 since replaced by COR-399) | See the amendment log below |
| D12 | Not recorded | — | D14 (Postgres volume), D25 (runner listener) |
| D13 | Not recorded | — | 2026-10-29: Juno has no concurrency. D23: designers. D30: global sessions |
| D14 | Not recorded | — | Amended D7 and D12 |
| D15 | 2026-10-28 | — | Not started. D23: role-specific menus |
| D16 | 2026-10-28 | — | COR-127 (deploy records), COR-514 (no CI gate), COR-241 and COR-323 (PM hold cards) |
| D17 | 2026-10-29 | — | — |
| D18 | 2026-10-29 | — | — |
| D19 | 2026-10-29 | — | COR-65 (spike findings), D20 (Design type), D21, COR-363 (board cards), COR-298 (type lock) |
| D20 | 2026-10-29 | — | D23 (designers author) |
| D21 | 2026-10-29 | — | D26 |
| D22 | 2026-10-29 | COR-133 | D27 (done-ness), D31 (one dependency graph) |
| D23 | 2026-10-29 | COR-155 | 2026-11-08: developer-authored design sessions retired |
| D24 | 2026-10-29 | COR-151 | COR-230 (2026-10-30), D26, D29 |
| D25 | 2026-10-29 | COR-182 | — |
| D26 | 2026-10-30 | COR-254 | COR-444 and COR-447 (2026-11-02): what developers check |
| D27 | 2026-10-29 | COR-163 | COR-166, COR-169, D26, COR-286–COR-291, COR-290, COR-445, COR-434, COR-435, D29, 2026-11-08 (`each_task` retired) |
| D28 | 2026-10-30 | COR-249 | COR-289 |
| D29 | 2026-11-02 | COR-407 | COR-434 |
| D30 | 2026-10-30 | COR-239 | COR-240, COR-241, COR-243, COR-246, COR-298, COR-323, COR-524 |
| D31 | Not recorded | COR-439 | COR-520 (vocabulary) |
| D32 | Not recorded | — | 2026-11-02 (Hugeicons), 2026-11-03 (`reka-nova`) |
| D33 | 2026-11-04 | — | — |

## Amendment log

Original wordings and dated changes, by decision. Each entry says what the text used to say; `decisions.md` has the result.

### D2, D18 and D15

- D2 originally named only Claude Code (`claude`). D18 extended it to `codex`.
- D15 amended D2 to allow one server-held key, for Jev. D15 is still not started, so that key doesn't exist yet. Its original text planned that "Atlas is always Claude Code, and Codex and Muse get developers (and reviewers) of their own", priced Jev at about $0.042 per million input tokens with output free (early-access pricing), and planned for the runner to report providers, models and thinking levels and for `RunJob` to gain neutral `runtime` and `effort` fields.

### D4

- D4 first chose evidence by task type, following the PRD §7.7 table. D19 changed it to evidence per acceptance criterion, and D21 separated gates from evidence and allowed note-only evidence. D21 overrode PRD §7.7's "test results" as evidence.

### D5

- **2026-10-28:** a project with no required checks used to force human review on every task. Since then its unflagged tasks merge on the reviewer's approval alone.
- D20 made design tasks always go to Human review. D19 (COR-65) did the same for spikes.
- D27 originally sent every subtask in `epic` mode through the flag as usual, merging into the task's branch, with every task's PR going to the human.
- **COR-286** applied the same routing to PR-free submissions, with Ready to merge meaning "integrate into the task's branch".
- **COR-289** moved a PR-free subtask's flag to the task's final approval: it goes to Ready to merge on agent approval, whatever its flag.
- **D28 (COR-249)** sent any task with a human-checked criterion to Human review.
- The rewrite replaced these seven links with one routing table.

### D6

- D6 also pointed at open recommendation R4 about projects with no required checks. D5's 2026-10-28 amendment and D26 settled it, and `open-recommendations.md` lists R4 as settled.

### D7

- D7 chose **Nuxt UI** for `web` and "PGlite + Drizzle, moving to Postgres when hosted". D14 moved the deployed instance to Postgres. D32 replaced Nuxt UI with shadcn-nuxt. It also resolved PRD §8.2's "Rust or Node" (Node) and replaced SvelteKit with Nuxt.

### D8

- Open recommendation R15 proposed sending every GitHub call through the runner's `gh`, so the login never leaves the runner container. It was built (D29's CI logs rely on it), and the rewrite folded it into D8.
- **COR-288** added the exception for task integration, which holds no task lease and pushes under the operation journal.

### D9

- D9 originally gave the PM a short tool list, with no tools to merge, edit docs or change task status, and `propose_plan` as its only way to change the board. D30 replaced the list with typed tools for every area; the limits on merging, docs and plan approval stand.
- **2026-10-28:** the human can approve a plan by asking Juno in chat (`approve_plan`), recorded as the human's approval and accepted only if the human wrote since the plan was proposed. The same day removed the delivery-summary turn: merged work used to be handed back to the PM.
- **2026-10-29:** one read-only checkout and one turn per Plan session, with 409 `pm_turn_in_progress`, and warm sessions.
- D20 added design approval as a turn trigger, D18 per-session runtimes, and D30 global sessions and thread messages (COR-243).

### D10

- **2026-10-28:** Draft (PM-proposed, not yet confirmed) and Ready to merge were added. Backlog replaced "Needs refinement" and the earlier name "Draft".
- **2026-10-29:** a Draft belongs to the Plan session of the latest plan that includes it.
- **2026-10-31 (COR-363):** a Ready card with unfinished dependencies shows an amber blocked icon with a **Waiting on** popover. Previously it said "waiting on #12".
- D20 added Approved and its transitions. D27 defined Ready to merge and Merged for subtasks in `epic` mode. D28 added `require_human_check`. D30 let the PM create any Backlog task and propose human transitions on a card, and added the PM's `answer` transition (COR-246) and the Merged, membership and type locks (COR-240, COR-298). D31 added the `parent` status.
- The Blocked list used to include "Non-trivial merge conflict the developer can't resolve". Conflicts now go through D24's rebase review or D29.

### D11

- The first D11 classified Inbox items differently, including an unread-reply rule (COR-103, COR-118, COR-130) and release notes placed per COR-127. **COR-399** replaced it with the actionable-decisions policy.
- D11 listed "the task conflict handover required by D27" (COR-166) and "internal fix tasks" as Needs-you or loop items. Both went with D29.
- D30 let the PM act on the Inbox, with its actions shown in an **Activity** tab. **D33 (2026-11-04)** removed that tab: the server still records informational items, and the web app doesn't list them. Every "appears in Activity" in D11, D16, D20, D27 and D30 was overridden by D33, and the rewrite removed them.
- **COR-436** added the recovery contract (one PM triage turn before escalation).

### D13

- D13 said "Plan sessions belong to one project" and "every PM session has a `projectId`". D30 added global sessions.
- **2026-10-29:** Juno has no concurrency, so PM turns are limited only to one per session. The `agents.concurrency` column was kept and is ignored for the PM.
- D23 added the designer role and its fresh-install seed.

### D16

- **COR-514:** the deploy used to wait for the `ci` check on `main`, and CI ran on pushes to `main`. Merges landed faster than CI finished, so `main` was nearly always still in CI at a tick, and deploys were held back.
- **COR-241, COR-323:** `set_update_hold` became confirm-required, and the banner's Lift works after finishing has latched.

### D19

- D19 replaced PRD §4.3's types (frontend, backend, full-stack, infrastructure). All existing tasks became `task` in migration `0015_task_bug_spike`.
- **2026-10-29 (COR-65):** spikes deliver findings instead of a PR.
- **2026-10-31 (COR-363):** the Board uses the Option A card (COR-154 v4), which removed the type badge, notes, ref, design-changed badge and PR link from cards in favour of a muted icon for Bug, Spike and Design. Those details stayed on the flyout and task page.

### D20 and D23

- D20 originally had the **developer** build the prototype, call `submit_design` and receive design feedback. D23 (COR-155) moved all of that to a new designer role, and listed its changes to D13, D15 and D20 as an overlay. The rewrite writes "the designer" into D20 directly.
- **D23's in-flight note:** a design task first authored by a developer, before D23, moved to a designer from its next authoring run, in a new session, never resuming the developer's session. Corral treated a developer's run as a session boundary for that. None was left unfinished, so on 2026-11-08 the boundary was retired (PR #383). `design_submitted` stays in the developer outcomes and the `runs_outcome_matches_role` check, because historical developer runs carry it.

### D22

- **2026-10-29:** D22 said a task with subtasks was done once all its board subtasks were Merged. D27 changed that to "its task's PR has merged", except in `direct` mode.
- D31 merged task dependencies, task-to-task dependencies and membership into one graph.

### D24

- **COR-151 (2026-10-29)** introduced rebase-only rounds, and **COR-230 (2026-10-30)** amended them. The reviewer reran the gates without the cache until D26.
- **D29** added `behaviourChanged` to `pr_rebased`. Before it, the `review` field alone decided the route.
- D24 was also the conflict path for subtask PRs into a task's branch, and its motivating example was COR-118 changing a binding decision under COR-106.

### D26

- Before D26 every reviewer reran lint, typecheck, tests and build without the cache. On COR-59 a reviewer's third full test run hit the background time limit. Corral's own `ci` workflow gained a build step when D26 moved the gates to CI; before that, `nuxt build` only ran at deploy.
- **COR-444, COR-447 (2026-11-02):** developers run targeted checks when the project has required checks.

### D27

- D27 originally said the project's default review mode "starts at `direct`". The schema and migration `0027_epic_review_modes.sql` have always defaulted to `epic`; the docs were corrected in PR #385.
- **COR-169** narrowed when a mode can change: before any subtask submitted, opened a PR or merged. Previously, before any had merged.
- **COR-166:** task PRs always squash, whatever the project's merge method. That part stands.
- **COR-286, COR-287, COR-288, COR-289** introduced PR-free subtasks in stages (below).
- **COR-290** moved the task's branch onto automatic rebase operations, **COR-445** deferred conflicts to the final checkpoint, **COR-291** defined approval across rebases, **COR-434** allowed target-only edits that integration review then sees, and **COR-435** stopped runners with a different tool contract.
- **D29** replaced the fix-task loop for reviewer changes, CI failures and conflicts with developer runs on the task.
- **2026-11-08:** `each_task` retired (PR #385).

### D28

- **COR-289** moved human checks on PR-free subtasks to the task's final approval. Before it, they sent the subtask to Human review before integration.

### D29

- The original measurement behind D29: subtask reviews were 21 of 88 runs in the period measured, with 29% of context tokens; 7 tasks with subtasks averaged 3 reviews each; and run #3842 spent 11.5 minutes failing to reproduce a CI failure it couldn't read.
- **Rollout:** after D29, conflicts created no task. Fix tasks reviewers had created before D29 were ordinary `fix` tasks and finished as tasks.

### D30

- D30 listed its changes to D9, D10, D11, D13, D16, D20 and PRD §7.2 as an amendments block. The rewrite moved each into the decision it amends.
- **COR-240** (PM task tools, Merged and membership locks), **COR-241** and **COR-323** (update hold cards), **COR-243** (threads and global sessions; design approval starts a turn), **COR-246** (`answer`), **COR-298** (type lock) and **COR-524** (plans can't turn off human review on a new top-level task where the project reviews by default).
- PRD §7.2: the PM still can't merge PRs, approve its own plan or modify canonical documentation. "Cannot bypass role permissions" now means D30's tools and rules.

### D31

- **Migration** (`0063_fresh_red_wolf.sql`): forward-only. It adds data and rewrites no branch, PR, review, evidence or status. Each delivery record with two or more live subtasks got a task numbered after the project's highest, with `createdAt` and `priority` from the delivery record, and `epics.merged_at` was backfilled from audit history, or for a `direct` task from its last subtask. The server reports `Parent tasks: N created, N one-task epics collapsed, N empty epics skipped`. A delivery record with one subtask was collapsed: `epics.task_id` stays null and the subtask stays top-level with its `epicId`, because `tasks_integration_protocol` needs it.
- **Rollout boundary:** PM tools run from the runner build, so a runner whose tool contract wasn't the server's took no runs until it updated (COR-435). Existing `list_tasks` fields only gained company.
- **COR-520** set the vocabulary: people see tasks and subtasks, and `epic` left the UI, Inbox text, PM prompts and tool descriptions.

### D32

- Cormac replaced Nuxt UI with shadcn-nuxt, preset `a31Y6GXo`, and asked for the frontend to be reorganised at the same time.
- The component style was `reka-vega` until **2026-11-03**, when Cormac switched it to `reka-nova` and kept the preset's colours, fonts and icons. The preset replaced the earlier teal and slate theme.
- Icons were Remix until **2026-11-02**, when Cormac switched them to Hugeicons. `shadcn-vue migrate icons` only converts from Lucide, so that switch was done by hand.
- Geist was bundled with `@fontsource-variable/geist` instead of the Google Fonts import `shadcn-vue init` adds.

### D33

- The Inbox listed agent progress, the PM's actions and undismissed release notes under an Activity tab (D11, D30, COR-129). Cormac removed it on 2026-11-04.

## Removed mechanisms

These were binding once, and their code is gone. Some columns, enum values and audit kinds remain so history stays readable.

### COR-166 hand-off conflict tasks

When a task's PR conflicted on its rebase before merge, Corral raised a Needs-you item and handed the conflict to a conflict task (`task_kind = 'conflict'`) on the task's own branch, with `rebase_handed_off` and `rebase_resolving` audit entries. COR-290 replaced it with automatic rebase operations, and PR #383 removed the code. The `conflict` task kind (migration `0062_gorgeous_expediter.sql`) and the audit text stay for history.

### COR-290 resolution tasks and COR-291's reviewer-based carry

Before D29, a conflict on the task's branch's rebase created a **resolution task** on the candidate `corral/epic-rebase/<operation>`, with its own criteria and a reviewer. Under COR-291, a reviewed resolution that kept behaviour carried approval once the reviewer approved it. D29 replaced both with a developer run on the task, `behaviourChanged` and the server's compare. PR #383 removed the code. `task_integration_operations.resolution_task_id`, `resolution_review` and history entries that name a resolution task and its review stay readable.

### D27's fix-task loop for reviewer changes and CI

D27 created a fix task for any requested change on the task's PR, from the reviewer or the human. D29 kept that only for a human's Request changes; reviewer changes and CI failures became developer runs on the task.

### GitHub branch updates for tasks with subtasks

D27 rebased the task's branch before merge with GitHub's `updatePullRequestBranch`. COR-290 replaced it with Corral's own rebase operations, because GitHub's update can't take the writer lock. PRs into the target branch still use it (D24).

### The `conflict` review state and two columns

A task's PR used to have review state `conflict`, with `epics.conflict_files` and `epics.rebase_requested`, from the COR-166 hand-off. Nothing wrote them after COR-290. Migration `0068_kind_shinobi_shaw.sql` (PR #384) dropped the state and both columns, along with the run states `starting`, `waiting_for_input` and `stopping`, which nothing wrote.

### Staged rollout and capability negotiation (COR-286 to COR-288)

PR-free subtasks arrived in stages:

- **COR-286** added the durable schema (submissions, operations, the journal) and the submission recorder.
- **COR-287** activated PR-free submission and review: a developer run selected integration protocol 1 for an eligible subtask with no PR on its branch, reporting `commit_submitted`.
- **COR-288** added the integration executor, `TaskIntegrator`.

**Rollout boundary:** existing subtasks with a task PR finished on the old path, including revisions and rebase rounds, keeping their branch, PR, evidence and approvals. Selection was persisted on the task, nothing was converted in the background, and existing PR records were never migrated into submissions.

**Capability negotiation:** during the rollout a runner advertised what it supported at hello: `taskIntegrationProtocols`, `taskIntegrationExecutor`, `epicRebaseExecutor` and `epicFixExecutor`. A developer run that landed on a runner without protocol 1 stayed on the task-PR path, and integration, rebase and fix jobs only went to runners that advertised them. The server also accepted a list of compatible older tool contracts (`COMPATIBLE_TOOL_CONTRACTS`), PM calls with old names (`update_epic`, `epicId`, `epicReviewModeDefault`, review mode `epic`), the old `propose_plan` input (`epics[]` and a task's `epic`) and a hello with no tool contract. PR #386 removed all of it and bumped the runner protocol to 5: every current runner supports everything, an older one is refused at hello with a readable reason (`legacyRunnerHelloSchema`), and one with a different tool contract gets no work.

Protocol 0 itself remains for standalone, `direct` and design tasks and for the `epic`-mode case D27 describes.

### `each_task`

A third review mode in which every subtask also went to Human review before the task's PR did. It was offered in project settings, the delivery picker, PM tools and plans. It was retired on 2026-11-08 (PR #385): nothing offers or accepts it, and the stored value remains on merged tasks, labelled "Each subtask (retired)".

## The simplification pass (November 2026)

[simplification-report.md](simplification-report.md) inventoried legacy paths, dead code and doc drift. These PRs carried it out: #380 (doc contradictions), #381 (dead code), #382 (one PM tool catalogue), #386 (runner and tool-contract compatibility), #383 (resolution tasks, hand-off conflict tasks, developer-authored design sessions), #384 (the `conflict` review state, two columns, three run states), #385 (`each_task`), and the rewrite of `decisions.md` into current state with this file.
