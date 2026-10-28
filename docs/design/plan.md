# Plan

**Canvas frames:** `App shell · Plan`, `Plan (component)` (the canvas still shows the plan as a card in the log; this spec moves it to the flyout)
**Route:** `/plan` (new session) and `/plan/:sessionId`
**Scope:** global. Each session belongs to one project.

## Purpose

The main place to work with Juno, the PM. Planning, refining Backlog tasks, answering PM questions and approving plans all happen here, and only here (D9, D11). Opening the page fresh should feel like starting a conversation: the composer is front and centre.

## Views

### New session (default when you open Plan)

Everything is centred vertically and horizontally, in a column up to 720px wide:

1. **Greeting:** Juno's avatar (a `primary`-tinted circle), "What should we plan, Cormac?", and "Juno reads {project}'s code, wiki and board before answering. Nothing reaches the board until you approve it."
2. **Composer** (large; see shared pattern): a 3-row minimum and 15px text, with a soft shadow. Toolbar, left to right:
   - **Attach** (paperclip).
   - **Project picker:** the project's colour dot, name and a chevron. Opens a listbox of projects, each with thumbnail, name, prefix and a check on the current one. It defaults to the project you were last in. It's locked once a session has messages, because a session belongs to one project.
   - **Refine a task:** opens a searchable popover listing that project's Backlog (ref, title, epic). Picking a task attaches it as a chip at the top of the composer: "Refining COR-18 Billing settings page". The task name is a link that opens the task flyout, and an × removes the chip. With a task attached you can send without typing, and the placeholder becomes "What should change about COR-18? (optional)".
   - **Resume:** opens a searchable popover of all past sessions (title and time). Picking one opens it.
   - The Enter hint and the Send button.
3. **Starter suggestions:** pill buttons that fill the composer.
   - Default: "Plan a new feature", "Break an epic into tasks", "What's blocking progress?"
   - With a task attached: "Tighten the acceptance criteria", "Split it into smaller tasks", "Check its dependencies"
4. **Recent sessions:** a bordered list of the last 4 sessions. Each row has an unread dot, the title, a status badge where there's something to do ("Needs approval" in `primary`, "Question" in `info`), the project dot and name, a one-line preview and the time. Clicking a row opens the session.

### Conversation

- **Header** (48px): the project dot and name, the session title, and a **New session** ghost button.
- **Message log** (`UChatMessages`, `role="log"`), centred and up to 768px wide:
  - **Your messages:** right-aligned, in a `bg-elevated` bubble.
  - **Juno's messages:** left-aligned with the avatar and "Juno · PM". While Juno is working, a thinking line reads "Reading the code, wiki and board…".
  - **Plan link** (inside Juno's message, when the message proposed or revised a plan): a compact bordered button, "Plan v2 · {epic}" and "Open plan" (or "Now v3" on an older version's message). It toggles the plan flyout. The plan itself is never drawn in the log, so revisions don't stack up cards.
- **Composer:** pinned to the bottom of the conversation, with a top divider. Same tools as above; the popovers open upwards.

### Plan flyout

Docked on the right (`?plan`), the same flyout as tasks and epics; the conversation narrows to make room. It always shows the session's **latest** plan version, so each revision updates it in place. It opens by itself when a new version arrives waiting for approval, unless a task or epic is already open.

- **Header:** a "Plan v2" badge, a status badge ("Waiting for approval" in `primary`, or "Approved" in `success`), and Close.
- **Title:** the plan title and "2 epics · 4 tasks · 8 criteria" (the epic count only when there's more than one).
- **One section per epic**, in the order Juno gave them: the epic title (opens the epic), "N tasks · N criteria", and **List** / **Graph** tabs, remembered per epic.
  - **List:** one row per task: the ref and title, and "N criteria · after {dependency}". Rows open the task in the flyout, with a back arrow to the plan.
  - **Graph:** the epic's dependency tree, top to bottom, as on the epic flyout ([epic.md](epic.md)). A dependency in another epic shows as a dashed placeholder. Clicking a node opens the task.
  - A Draft moved to another epic by hand is listed last, under **Other tasks**.
  - Removed tasks aren't listed, and what changed lives under Changes from v1.
- **Changes from v1** (collapsed): the added and changed tasks with a change badge (Added `success`, Changed `warning`), and "N tasks from v1 removed." Removed Drafts are deleted (D10), so only their count remains.
- **Footer** (pinned): **Add to board** (solid primary), **Add to backlog** (outline), and "Drafts until you choose. The board schedules them now; the Backlog keeps them for later or for refining." Afterwards it reads "✓ 4 tasks added to the board." (or "…to the Backlog").

### Task flyout

Docked on the right (see [task.md](task.md)). It opens from plan-flyout rows and from the attached-task chip. A proposed task is a **Draft**: the flyout shows a "Draft" badge and a reduced view: title, the editable properties (project, priority, type, developer, reviewer, human review), dependencies, description and acceptance criteria. There's no per-task Add to board / Add to backlog: Drafts are placed only with the whole plan, from the plan flyout. Status, branch, pull request, review round and the Activity / Evidence / History tabs are hidden, since none of them exist yet.

## Rules

- Only a human can approve a plan: with the buttons, or by telling Juno to in chat, which Juno carries out with `approve_plan` (D9). The approve endpoint rejects any other actor, and Juno's tool is refused unless the human has written since the plan was proposed.
- Editing a plan through chat creates a new plan version (v2, v3…), which replaces the one in the plan flyout and shows what changed.
- Editing a task directly in the flyout saves it to the task and logs you as the author. It doesn't create a plan version (flows.md).
- PM questions appear here as Juno messages, never in the Inbox (D11).

## Data

- **Sessions:** id, project, title, preview, updated time, unread, status (needs approval / question / none), messages.
- **Messages:** role, text, and an optional attached plan id.
- **Plans:** version, status, epics (key, id, title), tasks (ref, title, epic, change type, criteria count, dependencies).
- **Backlog search:** filtered to the session's project.
- **Streaming:** SSE for tokens and plan versions.

## States

- **Runner offline:** the composer is disabled, with "Plan needs the runner. It's offline." and Reconnect (D9).
- **Juno errors mid-turn:** an inline `UAlert` in the log with Retry.
- **No sessions yet:** the Recent list is hidden.

## Accessibility

- Popovers are listboxes with search inputs that have labels, and Escape closes them.
- The log is `aria-live="polite"`.
- The plan flyout is a `section` with an accessible name.

## Open questions

- Should editing a proposed task in the flyout create a new plan version, the way chat edits do? flows.md says no today.
- Do we need a full "All sessions" page, or is the Resume search enough?
