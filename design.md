# COR-190 · Inbox message panel (Option D) and epic review · v5

Prototype: `apps/web/prototype-dist/` (`pnpm --filter web prototype`). Open `index.html#/inbox`; the routes below go straight to each example. There is no option switcher any more.

v5 does what the human asked after v4: **D only**, and **what epic review looks like, with examples**.

- Options A, B, C and E, their shared drawer and the switcher are gone, so the prototype's Inbox now always shows D. The earlier versions keep them.
- The branch now includes `main`, so the prototype has the latest app, including the mobile Inbox work.
- D itself is as approved in v4, plus one line for tasks in an epic (below).

## Screens

| Screen id | What it is |
|---|---|
| `inbox-panel-option-d` | The task item panel on desktop |
| `inbox-panel-option-d-mobile` | The same on a phone, with the bar of large touch targets |
| `inbox-panel-epic-review` | **New:** an epic PR waiting on you, desktop |
| `inbox-panel-epic-review-mobile` | **New:** the same on a phone |
| `inbox-panel-epic-activity` | **New:** the read-only epic PR moments: opened, conflict, approved, merged |
| `inbox-panel-task-in-epic` | **New:** D for a task in an epic, with the "Part of…" line |
| `epic-pr-section` | **New:** the Epic PR block on the epic flyout and page |

## Epic review (D23, D11)

Under D23 the human reviews a feature once, as a whole, at its epic PR. Today only the epic's fields exist: nothing raises an Inbox item and there's no screen. This is that screen, in D's layout, so reviewing an epic feels the same as reviewing a task.

**What differs from a task review.** A task asks "did this task meet its criteria?". An epic asks "do these tasks work together, and do I want this on main?". So:

- The verdict line reads **Rita approved the epic · lint, test passed · 3 of 3 tasks merged · You saw 1 of 3**. "You saw" is the new idea: in `epic` mode most tasks merged without you, so this says how much of the feature you're seeing for the first time.
- Criteria are replaced by **Tasks n/m**, one row per task: who passed it, criteria met, its PR, and whether it was a fix or conflict task. A row opens the task.
- **Review** shows the integration findings first, then the reviewer's summary, for every round.
- A line under the actions says what approving does, because this one reaches the target branch: "Approving rebases onto main (6 commits ahead), runs CI and squash-merges."
- There's no Reply on an epic item: an epic has no comment thread to reply to, so you only approve or request changes.

**Tabs:** Overview · Tasks n/m · Review · PR description · Code diff N · Message. They're hidden by default and one click away, as on a task.

**Overview:** any non-blocking notes from the reviewer, then screenshots gathered from all the tasks (labelled with their task, opening the evidence viewer), then the review mode and size. In a later round, a **Since your last review** block leads.

**Actions:** *Approve epic* is sent on one click and the Inbox moves on. *Request changes* opens the composer; your text becomes a fix task in Ready in the epic (D23), and the Inbox moves on. On a phone both are 64px targets in the bottom bar, with the composer opening above it.

### Examples

| Example | Route | Shows |
|---|---|---|
| First review, `epic` mode | `#/inbox/e-searches` | Saved searches. D23's own worked example: you saw 1 of 3 tasks, with one non-blocking note and rebase needed |
| First review, `each_task` mode | `#/inbox/e-newsletter` | Newsletter signup, another project: "You saw all", so the review is about how they fit, and main hasn't moved |
| Round 2 after you requested changes | `#/inbox/e-exports` | Run history export: *Since your last review* quotes your feedback and names the fix task. **See only these changes** opens Code diff on *Since your last review* rather than *Whole epic* |
| Fix task in an `each_task` epic | `#/inbox/t-cor-52` | An ordinary task review with the "Part of Notification settings" line |
| Epic PR opened (Activity) | `#/inbox/audit-e-audit` | Read-only; Rita is reviewing |
| Epic PR conflict (Activity) | `#/inbox/audit-e-shortcuts` | Read-only; links conflict task COR-58, which isn't merged yet (2 of 3) |
| Epic PR merged (Activity) | `#/inbox/audit-e-themes` | Read-only; the squash commit |
| Approved, waiting on CI (Resolved) | `#/inbox/audit-e-thumbs` | Read-only; what happens next |
| Epic flyout and page | `#/epics/e-searches` | The Epic PR block: link, state, review mode, *Review in the Inbox* |

Acting works against the mock API. Approving moves the epic to Resolved. Requesting changes creates a real fix task in Ready and updates the epic's counts. Reload resets everything.

### Tasks in an epic

D's panel now has one line for a task in an `epic` or `each_task` epic: "Part of **Saved searches**. You'll review it all together at the epic PR." The epic name opens the epic. The ask reads "Approve and merge PR #64 into the epic branch, or request changes", because approving doesn't put it on main (D23). Its PR description shows the epic branch as the base. `direct` epics are unchanged.

### States

- **Waiting on you:** actions, the "what approving does" line and "You saw".
- **Read-only** (opened, conflict, merged, approved, or resolved by you): the same layout, with "For your information. Nothing to do." or the resolution in place of the actions; no action bar on a phone.
- **Loading:** the top block shows at once, with skeletons in the tab body until the review arrives.
- **Screenshots:** none means the Overview shows just the notes and the size.

### Components

New: `InboxEpicPanel`. Reused: `InboxPanelDiff`, `InboxPanelThumbBar` (now takes the approve label and can leave out Reply), `InboxPanelTray`, `EvidenceViewer`, `MarkdownText`, `UTabs`. `EpicDetail` gains the Epic PR block.

## Option D · `inbox-panel-option-d`, `inbox-panel-option-d-mobile`

Unchanged from v4.

- **Up front (desktop):** kind · project · ref · sender · time, the title, a **TL;DR**, the verdict, the actions and the PR or Preview link. Then the tabs **Overview · Criteria n/m · Review · PR description · Code diff N · Message**. Overview shows a screenshot grid and files on reviews, or what each action does on other items.
- **Up front (mobile):** the same, with the actions in a bottom bar of targets at least 64px tall, plus Reply. *Request changes*, *Answer* and *Reply* open the composer above the bar.
- **Hidden, one click away:** criteria notes, review history, PR description, diff and the full message.
- **Components:** `InboxPanel`, `InboxPanelMeta`, `InboxPanelVerdict`, `InboxPanelActions`, `InboxPanelThumbBar`, `InboxPanelArtifacts`, `InboxPanelDiff`, `InboxPanelDetails`, `InboxPanelTray`, `EvidenceViewer`, `MarkdownText`, `UTabs`. Composable: `useInboxPanel`.
- **Rationale:** familiar, and it scales to any amount of content. **Trade-off:** an unmet criterion's reason is one click away.

| Item | Route | Exercises |
|---|---|---|
| Code review COR-5 | `#/inbox/t-cor-5` | PR, gates, 4 of 5 criteria, image and text evidence, long reviewer summary, 2 rounds, in an epic |
| All-met code review COR-20 | `#/inbox/t-cor-20` | 5 of 5 criteria |
| Design review COR-18 | `#/inbox/t-cor-18` | Screenshots and Preview v1; *Approve design* uses the version endpoint |
| Question COR-19 | `#/inbox/t-cor-19` | Answer is already chosen on a phone |
| Blocked COR-8 | `#/inbox/t-cor-8` | Answer, Send back, Delete |
| Failed COR-9 | `#/inbox/t-cor-9` | Very long body, Retry |
| Activity COR-7 | `#/inbox/audit-7` | No actions |
| Resolved COR-10 | `#/inbox/audit-10` | The resolution |

## Mock data

`app/prototype/fixtures.ts`: task items as before, plus eight epics and their tasks, `epicReviews` and `epicItem()`. `mock-api.ts` answers `GET /epics/:id/review` and `POST /epics/:id/review/actions`.

```ts
EpicInboxItem: { id, type: 'epic_review', event: 'human_review' | 'opened' | 'conflict' | 'approved' | 'merged',
                 epicId, subject, preview, body, project, sender, at, prUrl, resolution, taskId: null, taskRef: null }
EpicReview:    { epicId, title, goal, reviewMode, state, targetBranch, pr: PullRequestDetail, gateChecks, targetMovedBy,
                 rounds: [{ round, verdict, reviewer, headSha, summary, findings: [{ level, text, taskRefs }], createdAt }],
                 tasks: [{ ref, title, prNumber, prUrl, kind, merged, reviewedBy, criteriaMet, criteriaTotal, evidence }],
                 lastFeedback: { text, at, fixTaskRefs, files } | null, conflictTaskRef, mergeCommitSha }
```

## ⚠ What the build needs that doesn't exist yet

Everything here is proposed in `packages/contracts/src/api.ts` and served only by the mock API.

- **Inbox:** an `EpicInboxItem`, in Needs you, Activity and Resolved.
- **`GET /epics/:id/review`** and **`POST /epics/:id/review/actions`**. These are new because `POST /inbox/:taskId/actions` is keyed on a task.
- **Integration findings:** the reviewer needs to report structured findings, not only a summary.
- **Fix and conflict marking:** tasks need a marker for `kind`; nothing records it today.
- **Feedback and "since" diff:** store the human's last request and compare the head they reviewed with the current head.
- **`ready_to_merge` on the epic:** D23 lists it, but `EPIC_REVIEW_STATES` doesn't, and it's a Postgres enum, so it needs a migration. The prototype keeps it on `EpicReview.state` only.
- **`PullRequestDetail`** (v3), for the task PR tabs: still mock only.
- **`summary` field:** the TL;DR is still the first paragraph of the body. A short agent-written summary would be more reliable, and matters more for epics.

## Open questions

1. **Approve with a note:** should a non-blocking reviewer note on an epic ask for confirmation? Decision for now: no, the note leads the Overview and approval is one click.
2. **Approve on an unmet task criterion:** same question as v1 for tasks, and still open.
3. **Reply on epic items:** is approve or request changes enough, or do you want to ask Rita a question about an epic?
4. **Large epic diffs:** cap the Code diff tab (e.g. 20 files or 1,000 lines) and link to GitHub for the rest? Epics will hit this far more often than tasks.
5. **Fix task title:** the prototype titles it from your first line. Should the PM rewrite it?
6. **Mobile Delete:** should it stay in the bottom bar, or move behind "More" so the bar never holds more than three actions?
7. **Task details flyout:** should it stay closed by default now the panel shows what's needed? The prototype keeps it closed.
