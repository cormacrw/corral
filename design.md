# COR-190 · Inbox message panel: five options · v3 (Option D chosen)

Prototype: `apps/web/prototype-dist/` (`pnpm --filter web prototype`). Open the Inbox and use the
**Current · A · B · C · D · E** strip at the top (prototype only), or go straight to a URL:
`index.html#/inbox/t-cor-5?option=a`. The option stays chosen as you move between items and after acting.
Phones: the same URL at 390px (the screenshots force the phone layout with the app's own
`corral.device.layout = mobile` override, as a touch phone gets automatically).

Every option keeps the list column and Plan threads exactly as today. Only the task item panel changes.

## Fixture items (all rendered by every option)

| Item | URL id | What it exercises |
|---|---|---|
| Code review COR-5 | `t-cor-5` | PR #64, gate checks lint/test, 5 criteria (4 met, 1 unmet), 3 screenshots + text evidence (log, request, test output, note), long reviewer summary, 2 review rounds |
| All-met code review COR-20 | `t-cor-20` | PR #66, lint/test gates, 5 of 5 criteria met, image + text evidence, long reviewer summary and history |
| Design review COR-18 | `t-cor-18` | Design version v1 with 4 screenshots and a preview link (`/designs/dv-18-1`), 3 of 3 criteria |
| Question COR-19 | `t-cor-19` | Developer question, primary action Clarify |
| Blocked COR-8 | `t-cor-8` | Blocked with a question |
| Failed COR-9 | `t-cor-9` | **Very long body** (headings, logs, options) |
| Activity COR-7 | Activity tab, `audit-7` | Read-only, no actions |
| Resolved COR-10 | Resolved tab, `audit-10` | Resolved: shows the resolution as the "ask" |

Mock data shape: `TaskInboxItem` from `inbox()` in `app/prototype/fixtures.ts`, `Task` (acceptanceCriteria, gateChecks,
latestReview, reviewer), `Evidence[]` and `Review[]` from the existing endpoints, and `DesignVersion[]` from
`GET /projects/:slug/tasks/:number/designs`. The mock API answers `POST /inbox/:taskId/actions` and `POST /projects/:slug/tasks/:number/designs/:version/approve`. Design approval uses the version-specific endpoint, marks the version approved, supersedes earlier versions, moves the task to Approved and advances selection. Code approvals still move to Ready to merge.

## v3 revision: Option D chosen

The human picked **Option D** for desktop, asked for **PR description** and **Code diff** tabs, and for **large touch areas for each action at the bottom of the screen** on mobile. A, B, C and E stay in the switcher unchanged, for reference only. The switcher labels D "TL;DR + tabs · chosen (v3)".

- **New tabs (code reviews with a PR):** Overview · Criteria n/m · Review · **PR description** · **Code diff N** · Message. Design reviews, questions, blocked, failed, activity and resolved items have no PR, so these tabs don't show for them.
  - *PR description:* `#64 Title`, head → base branch, then the PR body as markdown (`MarkdownText`).
  - *Code diff:* a summary line ("3 files +27 −7 head → base" plus *Open on GitHub* to `/files`), then one block per changed file with its path, status and +/− counts. Each block expands to a unified diff with added lines tinted success and removed lines tinted error, in mono with horizontal scroll. The first file starts open and the rest are collapsed. New component: `InboxPanelDiff`.
  - Both tabs are hidden by default and one click away, like the other long text. The diff is never in the way of deciding.
- **Mobile action bar (`inbox-panel-option-d-mobile`):** the actions leave the top block and move to a bar pinned to the bottom of the screen, within thumb reach (`InboxPanelThumbBar`).
  - Every action is its own target, at least 64px tall, filling the width in equal parts with an icon above a short label: *Approve and merge / Approve design / Answer / Retry* (primary, filled), *Request changes / Send back* (outline), *Delete* (outline, red text). A fixed-width **Reply** target sits at the end.
  - Actions that need no words are sent on the tap and the Inbox moves on. *Request changes*, *Answer* and *Reply* open the composer directly above the bar, so the bar never moves. A question opens with *Answer* already chosen, as today's phone Inbox does.
  - The top block now holds only what it is, the TL;DR, the verdict and the PR/Preview link, which leaves more room for the tabs. Tabs scroll sideways on a phone.
- **Desktop** keeps D's layout from v2: actions sit inline under the verdict, and the reply composer is pinned at the bottom.

### New data: PR description and diff

`Task` and `TaskInboxItem` carry only `prUrl`/`prNumber`. Neither the PR body nor the diff is served today. The prototype proposes a **`PullRequestDetail`** contract (`packages/contracts/src/api.ts`): `{ number, url, title, body, baseBranch, headBranch, files: [{ path, status, additions, deletions, patch }] }`. It is served at **`GET /projects/:slug/tasks/:number/pull-request`** (`api.tasks.pullRequest`), and only the mock API answers it so far. The server would read it from GitHub with the project's token, the same way the Pull requests page reads gate status. It loads when a code-review item with a PR opens. Fixtures: COR-5 and COR-20 (`pullRequestDetails` in `fixtures.ts`). Large diffs need a cap (see open questions).

## v2 revision

- `DesignPreview` uses a bundled HTML document via `srcdoc` only in prototype builds. The same sandbox remains (`allow-scripts`, no same-origin). Preview v1 opens the real `/designs/dv-18-1` route and its iframe shows an interactive mock Agents layout (Grid / List / Role board), without any backend request. Production keeps the existing API preview URL.
- B's filmstrip now opens the existing EvidenceViewer on the first click, while updating the hero for when the viewer closes.
- Approve design uses the existing design-approval API contract and mock version/task transitions; it never follows the code merge path.
- COR-20 is a separate all-met code review, alongside COR-5's 4-of-5 state. Both appear in every option, including at phone width.
- The five visual directions and the open product decisions below are unchanged.

## Shared across all options

- **What it is:** kind as icon + plain word (Code review, Design review, Question, Blocked, Failed, Activity, Resolved), project · ref · sender · time as one quiet line. No type badges (COR-154 taste).
- **The ask:** one derived line, e.g. "Approve and merge PR #64, or request changes", "Answer Victor's question".
- **Verdict:** plain text with icons: "✓ Rita approved · round 2", "✓ lint, test passed", "✗ 4 of 5 criteria met" (red when any unmet).
- **Artifacts:** screenshot thumbnails (open the existing evidence viewer, now `EvidenceViewer.vue`, extracted from `EvidenceList`), PR link and design preview link (both open in a new tab).
- **Primary action:** one click. Actions needing no text (Approve and merge, Approve design, Retry, Send back, Delete) are sent immediately; Request changes / Clarify pick the action and focus the reply box. After acting, the Inbox moves on to the next item (as today).
- **Hidden by default, one click away:** full body, reviewer criterion notes + evidence groups (`EvidenceList`), review history.
- **TL;DR line:** the body's first paragraph as plain text, clipped to 180 characters. ⚠ See open questions: a real summary field would be better.
- With an option on, the Task details flyout starts closed so the panel gets the full width; the Task details button still opens it.

Components (new, `apps/web/app/components`): `InboxPanelA…E`, `InboxPanelMeta`, `InboxPanelVerdict`, `InboxPanelArtifacts`,
`InboxPanelActions`, `InboxPanelTray` (reply composer; wraps `PromptComposer`), `InboxPanelDetails` (body · `EvidenceList` · history),
`InboxPanelSheet` (`USlideover` on desktop, `UDrawer` on phones), `EvidenceViewer`, `InboxOptionSwitcher`; composable `useInboxPanel`.

## Option A · Verdict card · `inbox-panel-option-a`, `inbox-panel-option-a-mobile`

- **Up front:** one card: ask (with arrow), 2-line TL;DR, verdict line, criteria as a ✓/✗ checklist (one line each, unmet in red), thumbnail strip + PR / Preview, Approve + Request changes buttons. Reply box pinned at the bottom.
- **Hidden:** *Details ▾* under the card expands body, criteria notes with evidence, history inline.
- **States:** review (code/design) shows checklist; question/blocked/failed show ask + TL;DR + their actions; activity/resolved show the resolution and no actions or tray.
- **Mobile:** same card stacked under the shell header; thumbnails smaller, title moves into the panel.
- **Rationale:** closest to today, cheapest to build, readable in one glance. **Trade-off:** with many criteria (8+) the checklist pushes the actions below the fold on a phone; we may need to collapse met criteria into a count past ~6.

## Option B · Artifacts first · `inbox-panel-option-b` (desktop), `inbox-panel-option-b-mobile`

- **Up front:** a large stage with the selected screenshot (click → viewer) and a filmstrip (each thumbnail selects the hero and opens EvidenceViewer immediately); a 340px rail with kind, title, ask, verdict (stacked), PR / Preview, full-width Approve / Request changes, *Read message*. Items without screenshots lead with their TL;DR in large type instead.
- **Hidden:** *Read message* opens a side sheet (bottom sheet on phones) with body, notes, history.
- **Mobile differs:** stage on top (≈210px) with filmstrip, rail content below, reply box at the bottom.
- **Rationale:** judging outcomes means looking at them; best for design reviews and UI work. **Trade-off:** for code tasks whose evidence is text (logs, requests), the stage is empty and the option degrades to a summary; criteria are only a count, not a list.

## Option C · Checklist · `inbox-panel-option-c` (mobile: same layout stacked, actions below the title)

- **Up front:** header with title, ask and actions; a single list: a checks row (verdict + PR/Preview), then one row per criterion, **unmet first**, each with its evidence thumbnail inline (click → viewer) and a file/note icon when there's more.
- **Hidden:** expand a criterion row for the reviewer's note and all its evidence; a *Message* row (shows TL;DR collapsed) expands the body; *Review history · N rounds* row expands history.
- **Rationale:** maps exactly onto how Corral judges work (criteria + evidence, D19/D21). **Trade-off:** for question/blocked/failed there are no criteria, so it becomes a header + message row, i.e. like A; the most rows to scan when criteria are many.

## Option D · TL;DR + tabs · **chosen** · `inbox-panel-option-d`, `inbox-panel-option-d-mobile`

- **Up front (desktop):** kind · project · ref · sender · time, title, a **TL;DR** line, the verdict, the actions and PR/Preview. Then the tabs **Overview · Criteria n/m · Review · PR description · Code diff N · Message**. Overview shows a screenshot grid and the files (reviews), or what each action does (other items).
- **Up front (mobile, `inbox-panel-option-d-mobile`):** the same top block without the actions. The actions are in the bottom bar of large touch targets, with Reply, and the composer opens above the bar on demand (see v3 revision).
- **Hidden:** criteria notes (Criteria tab), history (Review tab), PR body (PR description tab), diff (Code diff tab) and message body (Message tab), each one click or tap away.
- **States:** code review with a PR (all six tabs); all-met code review (COR-20); design review (no PR tabs, Preview v1 link, screenshot grid); question, blocked and failed (Overview + Message, with the composer for Answer); activity and resolved (no actions, no bar).
- **Components:** `InboxPanelD`, `InboxPanelMeta`, `InboxPanelVerdict`, `InboxPanelActions` (desktop), `InboxPanelThumbBar` (mobile), `InboxPanelArtifacts`, `InboxPanelDiff`, `InboxPanelDetails`, `InboxPanelTray`, `EvidenceViewer`, `MarkdownText`, `UTabs`.
- **Rationale:** familiar, scales to any amount of content. **Trade-off:** the tab bar hides the unmet criterion's reason one click away; tabs don't fit more than four on a phone.

## Option E · Triage · `inbox-panel-option-e` (mobile: same, big buttons stacked)

- **Up front:** a slim bar "2 of 9 · project · ref · Details · Skip →", then centred: kind icon, title, ask, verdict, thumbnails + links, two big buttons (Approve / Request changes, or Clarify / Send back), minor actions as links. No reply box until an action needs words or you tap *Reply*.
- **Hidden:** *Details* opens the side/bottom sheet with body, notes, history.
- **Interactions:** acting moves to the next item; *Skip* goes to the next without acting (wraps).
- **Rationale:** fastest for back-to-back review. **Trade-off:** least context; the unmet criterion is only "4 of 5" until Details is opened, so it relies on trusting the reviewer's verdict.

## Data the contracts don't have yet

- **All options:** the TL;DR is the body's first paragraph. A short `summary` field on `TaskInboxItem` (written by the agent, ≤ 140 chars) would make it reliable. The "ask" line is derived from type + task type and needs nothing new.
- **All options, design reviews:** the preview link and design screenshots come from `GET …/designs`, which the task page calls but the Inbox page doesn't yet (one extra request per design item). Alternatively add `designVersionId` to the inbox item.
- **Option E:** Skip / position use the Needs-you list already loaded; nothing new.
- Reviewer name: `Task.reviewer` is the latest reviewer run's agent; fine as is.

## Open questions

v3 (Option D):

1. **Large diffs:** cap the Code diff tab (e.g. 20 files or 1,000 lines) and link to GitHub for the rest? Should generated files and lockfiles start collapsed?
2. Should the PR description tab be dropped when the PR body only repeats the agent's message, or always shown?
3. On mobile, should *Delete* stay in the bottom bar, or move behind a "More" target so the bar never holds more than three actions?

Earlier (v1–v2):

1. Which direction (or blend, e.g. A's card with C's inline thumbnails, E's next-item flow on phones)?
2. Should the agent write a short summary field, or should the panel keep deriving it from the body?
3. With an unmet criterion and an approving reviewer, should Approve ask for confirmation, or is the red "4 of 5" enough?
4. Should the Task details flyout stay closed by default once the panel shows everything needed?
5. Keyboard shortcuts for Triage (A approve, R request changes, J skip)?