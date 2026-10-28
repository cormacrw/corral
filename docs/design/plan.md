# Plan

**Canvas frames:** `App shell · Plan`, `Plan (component)`
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
  - **Plan card** (inside Juno's message):
    - **Header** (`bg-muted`): "Plan v2 · {epic}", a badge ("Waiting for approval" in `primary`, or "Approved" in `success`), and "4 tasks · 8 criteria".
    - **One row per task:** a change badge (Added `success`, Changed `warning`, Unchanged neutral, Removed `error`), the title, and "N criteria · after {dependency}". Rows are buttons that open the task flyout; the open row stays highlighted. Removed rows are struck through and can't be opened.
    - **Footer:** **Approve plan** (solid primary), **Changes from v1** (outline), and "Approving moves these tasks from Backlog to Ready."
    - After approval the footer reads "✓ Approved. 4 tasks moved to Ready and onto the board."
- **Composer:** pinned to the bottom of the conversation, with a top divider. Same tools as above; the popovers open upwards.

### Task flyout

Docked on the right (see [task.md](task.md)); the conversation narrows to make room. It opens from plan-card rows and from the attached-task chip. Proposed tasks show status Backlog, no agents assigned, and comments are saved as notes.

## Rules

- Only a human can approve a plan. The approve endpoint rejects any other actor (flows.md).
- Editing a plan through chat creates a new plan version (v2, v3…), and the card shows what changed.
- Editing a task directly in the flyout saves it to the task and logs you as the author. It doesn't create a plan version (flows.md).
- PM questions appear here as Juno messages, never in the Inbox (D11).

## Data

- **Sessions:** id, project, title, preview, updated time, unread, status (needs approval / question / none), messages.
- **Messages:** role, text, and an optional attached plan id.
- **Plans:** version, status, tasks (ref, title, change type, criteria count, dependencies).
- **Backlog search:** filtered to the session's project.
- **Streaming:** SSE for tokens and plan cards.

## States

- **Runner offline:** the composer is disabled, with "Plan needs the runner. It's offline." and Reconnect (D9).
- **Juno errors mid-turn:** an inline `UAlert` in the log with Retry.
- **No sessions yet:** the Recent list is hidden.

## Accessibility

- Popovers are listboxes with search inputs that have labels, and Escape closes them.
- The log is `aria-live="polite"`.
- The plan card is a `section` with an accessible name.

## Open questions

- Should editing a proposed task in the flyout create a new plan version, the way chat edits do? flows.md says no today.
- Do we need a full "All sessions" page, or is the Resume search enough?
