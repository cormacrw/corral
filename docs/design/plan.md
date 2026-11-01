# Plan

**Canvas frames:** `App shell · Plan`, `Plan (component)` (the canvas still shows the plan as a card in the log; this spec moves it to the flyout)
**Route:** `/plan` (new session) and `/plan/:sessionId`
**Scope:** global. Each session belongs to one project.

## Purpose

The main place to work with Juno, the PM. Planning, refining Backlog and unclaimed Ready tasks, answering PM questions and approving plans all happen here (D9). Open sessions with a question or a plan needing approval also appear in the Inbox as Plan threads, showing just that question or plan, where it can be answered or approved too (D11, amended 2026-10-29; see [inbox.md](inbox.md#plan-threads)). The full conversation lives only here. Opening the page fresh should feel like starting a conversation: the composer is front and centre.

## Views

### Side nav threads

Open sessions appear as indented sub-items under **Plan** in the left sidebar, in opening order. Both Plan pages use this navigation without a tab strip.

- **Opening:** starting a session or opening one from Resume, Drafts or the Inbox adds it at the end, including a closed session. Sending a message adds the session back too. Clicking a thread switches conversations without a full reload; the current session is highlighted.
- **Each thread:** the project dot and truncated title, with the full title on hover. Hover or keyboard focus reveals an **×**, which removes only the nav entry. The session remains in Resume (and in the Inbox while it has a question or a plan needing approval), and removing the current entry leaves its page open. Each thread also has a **⋯** menu with **Close thread**, which confirms before closing that session without opening it. To abandon the current session, use **Close thread** in the conversation header.
- **Needs attention:** a plan waiting for approval, a question, a failed Juno turn or an unseen finished Juno reply makes the title bold. The first three are Inbox items too; an unread reply, or an idle session, is shown only here. The right indicator is a `primary` dot for **Needs approval**, an `info` dot for **Question**, an `error` dot for **Failed turn**, otherwise a neutral dot for **Unread reply**, in that priority order. Its tooltip names the reason. While Juno is working (`activeRunId`), a spinner replaces the dot.
- **Plan badge:** the number of open threads needing attention, including the current session's approval or question. It remains visible when the sidebar is collapsed; the thread list scrolls separately so the badge stays visible.
- **Read state:** a turn finishing in the session being viewed is marked read immediately. That session never displays an unread reply indicator; questions and approvals still need attention.
- **Live:** `plan.session` events update statuses and the badge without polling, here and in the Inbox. A session becoming `closed`, after its plan is added to the board or Backlog or after **Close thread**, leaves the nav immediately, and an explicit **Close thread** on the current session goes to `/plan`.
- **Persistence:** open threads and their order use localStorage (`corral.plan.tabs`, retained for compatibility). Sessions that no longer exist, and closed sessions not being reopened, are dropped on load.

### New session (default when you open Plan)

Everything is centred vertically and horizontally, in a column up to 720px wide:

1. **Greeting:** the PM’s avatar (a `primary`-tinted circle) and "What should we plan?".
2. **Composer** (large; see shared pattern): a 3-row minimum and 15px text, with a soft shadow. Toolbar, left to right:
   - **Attach** (paperclip).
   - **Project picker:** the project's colour dot, name and a chevron. Opens a listbox of projects, each with thumbnail, name, prefix and a check on the current one. It defaults to the project you were last in. It's locked once a session has messages, because a session belongs to one project.
   - **Runtime picker** (D18): which CLI Juno runs on for this session, "Claude" or "Codex". It lists only the CLIs the runner has, and remembers the last one picked (Claude until the runner answers). Like the project, it's locked once the session has messages, because an agent session only resumes on the vendor that made it: the conversation's composer shows it as a disabled button with a lock, and `PATCH /plan/sessions/:id` refuses to change it (409 `plan_session_runtime_locked`).
   - **Refine a task:** opens a searchable popover listing that project's Backlog (ref, title, epic). Picking a task attaches it as a chip at the top of the composer: "Refining COR-18 Billing settings page". The task name is a link that opens the task flyout, and an × removes the chip. With a task attached you can send without typing, and the placeholder becomes "What should change about COR-18? (optional)".
   - **Grill me:** asks Juno to question you. With an empty composer it sends "Grill me"; with a draft it sends "Grill me on this: {draft}". It's on the conversation's composer too, and is disabled while Juno is working.
   - **Resume:** opens a searchable popover of all past sessions (title and time). Picking one opens it.
   - The Enter hint and the Send button.
3. **Drafts:** shown only when the project has Drafts (`GET /projects/:slug/drafts`), in the same bordered list style. Drafts are grouped by the Plan session they belong to: a header row with the session title, "Needs approval" in `primary` while its plan waits, and the time, then one row per draft with its ref, type icon, title and priority. The header opens the session; a draft opens the session with that task in the flyout (`/plan/:id?task=COR-13`), or the task sheet on phones, where every row is full width and at least 48px tall. `plan.drafts` keeps it current, so approving a plan to the board or the Backlog takes its drafts out straight away. A Draft's task detail banner has an **Open plan session** link back to its session.

### Conversation

- **Header** (48px): the project dot and name, the session title, a neutral badge naming the session's runtime ("Claude" or "Codex"), **Close thread** (ghost) and a **New session** ghost button.
- **Close thread:** asks for confirmation ("Close this thread?", with **Close thread** in `error` and **Cancel**), then discards the session's Draft tasks and its unapproved plan, stops a running Juno turn and closes the session, the same action as in the Inbox ([inbox.md](inbox.md#close-thread)). The thread leaves the side nav and the Inbox at once; closing the current session navigates to `/plan` (the new-session view). Closing another session from its side nav menu keeps the current page open. Sending a message to a closed session reopens it, without the discarded drafts and plan. Tasks already added to the board or Backlog are left as they are; any dependency they had on a discarded draft is dropped rather than blocking them. It's hidden on a session that's already closed.
- **Message log** (`UChatMessages`, `role="log"`), centred and up to 768px wide:
  - **Your messages:** right-aligned, in a `bg-elevated` bubble.
  - **Juno's messages:** left-aligned with the avatar and "Juno · PM".
    - **Live turn:** while Juno is working, the turn's transcript streams in at the bottom of the log as it arrives (SSE `run.events`), in the agent page's style ([agent.md](agent.md)): messages, and tool calls with their input and output collapsed into step groups. The log follows the bottom unless you've scrolled up to read, until you come back down or send something. Until the first event arrives, a working line reads "Reading the code, wiki and board…".
    - **Past turns:** a finished turn's first message has a collapsed "Steps" disclosure above it. Opening it loads that run's saved transcript (`GET /runs/:id/transcript`) and the label becomes "N steps". The count isn't stored anywhere, so it's only known once loaded.
    - The turn's own messages (its reply, a question, a plan summary) are shown once, as messages in the log, and left out of its transcript.
  - **Questions:** Juno's questions sit in an `info`-tinted card. When Juno gave a recommendation or options, the card shows "Recommended: …" with **Accept recommendation**, one button per option, **Other…** (puts the cursor in the composer for a free-text reply) and **Stop and propose the plan** (sends "Stop asking questions and propose the plan now."). A tap sends that answer as your message straight away and starts Juno's next turn; any draft in the composer stays. Only the latest question you haven't replied to is live, and only while Juno isn't working; older and answered cards keep their buttons disabled, with the answer you gave marked (Other… for a typed reply). Questions without a recommendation or options are just the card.
  - **Plan link** (inside Juno's message, when the message proposed or revised a plan): a compact bordered button, "Plan v2 · {epic}" and "Open plan" (or "Now v3" on an older version's message). It toggles the plan flyout. The plan itself is never drawn in the log, so revisions don't stack up cards.
- **Composer:** pinned to the bottom of the conversation, with a top divider. Same tools as above; the popovers open upwards.

### Plan flyout

Docked on the right (`?plan`), the same flyout as tasks and epics; the conversation narrows to make room. It always shows the session's **latest** plan version, so each revision updates it in place. On desktop it opens by itself when a new version arrives waiting for approval, unless a task or epic is already open. On phones it doesn't (see [Mobile](#mobile)).

- **Header:** a "Plan v2" badge, a status badge ("Waiting for approval" in `primary`, or "Approved" in `success`), and Close.
- **Title:** the plan title and "2 epics · 4 tasks" (the epic count only when the plan has epics, "1 epic" for one).
- **One section per epic**, in the order Juno gave them: the epic title (opens the epic), "N tasks · Review: {mode}" (Epic PR, Each task or Direct, D27), an "After: {epic titles}" line when it depends on other epics, and **List** / **Graph** tabs, remembered per epic.
  - **List:** one row per task: the ref and title, a subline with the priority (Urgent in `error`, High in `warning`, Medium and Low muted), "· Human review" with a user-check icon when the task needs human review, and "· after {dependency}", and a **New** (`success`) or **Revised** (`warning`) badge. A Revised row is an existing Backlog task or unclaimed Ready task the plan refines by its ref; it shows the plan's proposed title, priority, human review and dependencies, while the task itself (opened from the row) is unchanged until approval. A revised Ready task stays in Ready with either button. Rows open the task in the flyout, with a back arrow to the plan.
  - **Graph:** the epic's dependency tree, top to bottom, as on the epic flyout ([epic.md](epic.md)). A dependency in another epic shows as a dashed placeholder. Clicking a node opens the task.
  - Tasks with no epic, and a Draft moved to another epic by hand, are listed last, under **Other tasks** (just **Tasks** when the plan has no epics).
  - Removed tasks aren't listed, and what changed lives under Changes from v1.
- **Changes from v1** (collapsed): the added and changed tasks with a change badge (Added `success`, or Revised for an existing task the revision starts refining; Changed `warning`), and "N tasks from v1 removed." Removed Drafts are deleted (D10), so only their count remains; a revised task that's removed is only un-staged and stays as it was.
- **Footer** (pinned): **Add to board** (solid primary), **Add to backlog** (outline), and "New tasks stay Drafts, and revised ones unchanged, until you choose. The board schedules them now; the Backlog keeps them for later or for refining." A plan that revises a Ready task adds "A revised Ready task stays in Ready either way." Afterwards it says where the tasks are, not where they were sent: "✓ 4 tasks on the board.", "✓ 4 tasks in the Backlog." or, with a revised Ready task approved to the Backlog, "✓ 3 tasks in the Backlog, 1 on the board.".

### Task flyout

Docked on the right (see [task.md](task.md)). It opens from plan-flyout rows and from the attached-task chip. A proposed task is a **Draft**: the flyout shows a "Draft" badge and a reduced view: title, the editable properties (project, priority, type, developer, reviewer, human review), dependencies, description and acceptance criteria. There's no per-task Add to board / Add to backlog: Drafts are placed only with the whole plan, from the plan flyout. Status, branch, pull request, review round and the Activity / Evidence / History tabs are hidden, since none of them exist yet.

## Mobile

On the mobile layout ([mobile.md](mobile.md)) the same two routes keep their behaviour, laid out for a phone:

- **Session switcher:** the side nav threads become a history button in the header. It opens a bottom sheet with **New session**, the open sessions (status badges, unread dot, spinner while Juno works, and × to close one, same rules as the side nav threads) and the other sessions under **Resume**.
- **New session:** the column starts at the top and scrolls. The Resume picker moves to the switcher.
- **Conversation:** full height, without the tab bar. The header shows a back button to `/plan`, the project dot and name above the session title, the switcher, **+** (new session) and a **⋯** menu with **Close thread**, which confirms in a bottom sheet.
- **Questions:** the open question's answers are stacked, full-width buttons at least 44px tall: Accept recommendation, each option, Other… (focuses the composer, which opens the keyboard) and Stop and propose the plan. Older and answered questions keep the web's compact row, disabled, with the answer marked. When Juno's next question arrives, the log scrolls to the top of it.
- **Grill me** comes first in both composers' toolbars, so it's in reach without scrolling the toolbar sideways.
- **Plan pill:** on phones a proposed plan **no longer opens on arrival**; a sheet popping up mid-reply would cover what Juno just said. Instead, while the session has a plan, a floating pill sits above the composer: centred and rounded, with a list icon, reading "Plan vN · x tasks" (excluding removed tasks). A proposed plan uses `primary` styling and "Needs approval"; an approved plan uses neutral styling. The pill sits in its own fixed row just above the composer, outside the scrolling log, so it covers neither answers nor the composer. Tapping it opens the plan sheet (`?plan`); it hides while the plan is open and returns on close.
- **Plan sheet:** `?plan` opens the plan in a bottom sheet instead of the flyout, with the approve buttons side by side. A task or epic opened from it opens in a taller sheet over it, whose back arrow returns to the plan. Swiping a sheet down closes it. Approving from the sheet, to the board or the Backlog, closes it and goes to a new thread (`/plan`) so the next request is a tap away, with a "Plan approved" toast saying where the tasks are, as the footer does: "2 tasks on the board" (or "2 tasks in the Backlog"). If approval fails, the sheet stays open on the session with the error toast.
- **Runner offline:** an error alert, "Plan needs the runner. It's offline.", says the sessions and drafts are safe and has **Reconnect** (which re-reads the runner's status). The composer is disabled with "Juno is unavailable while the runner is offline". Below it, "You can still read the Inbox, the board and past runs." remains visible.

## Rules

- Only a human can approve a plan: with the buttons, or by telling Juno to in chat, which Juno carries out with `approve_plan` (D9). The approve endpoint rejects any other actor, and Juno's tool is refused unless the human has written since the plan was proposed.
- Editing a plan through chat creates a new plan version (v2, v3…), which replaces the one in the plan flyout and shows what changed.
- Editing a task directly in the flyout saves it to the task and logs you as the author. It doesn't create a plan version (flows.md).
- PM questions appear here as Juno messages. The Inbox shows the same session's question or plan as a Plan thread, not a copy, so answering in either place answers it in both (D11).
- Closing a thread discards its Drafts and unapproved plan and stops a running turn; only the human closes a thread, from the Inbox or here (D11).

## Data

- **Sessions:** id, project, title, preview, updated time, unread (set whenever a Juno turn finishes, cleared on opening the session or sending a message), closed (set when its plan is approved, to the board or the Backlog, or the human closes the thread; a new message reopens it), status (needs approval / question / failed / none), messages.
- **Messages:** role, text, and an optional attached plan id.
- **Plans:** version, status, epics (key, id, title, review mode), tasks (ref, title, epic, change type, priority, human review, dependencies).
- **Backlog search:** filtered to the session's project.
- **Streaming:** SSE for tokens and plan versions.

## States

- **Runner offline:** the composer is disabled, with "Plan needs the runner. It's offline." and Reconnect (D9).
- **Juno errors mid-turn:** an inline `UAlert` in the log with Retry.
- **No drafts:** the Drafts section is hidden.

## Accessibility

- The tab strip is a `tablist` ("Open sessions") with one tab stop, the current tab. Left and Right arrows (wrapping), Home and End move between tabs, including +; Enter or Space opens one, and Delete closes it. Tab moves on to the current tab's close button. Close buttons are labelled "Close {title}", and the status indicators have screen-reader text.
- Popovers are listboxes with search inputs that have labels, and Escape closes them.
- The log is `aria-live="polite"`.
- The plan flyout is a `section` with an accessible name.

## Open questions

- Should editing a proposed task in the flyout create a new plan version, the way chat edits do? flows.md says no today.
- Do we need a full "All sessions" page, or is the Resume search enough?

## Epic dependencies in proposals

`propose_plan` accepts an optional `dependsOn` on each epic: keys of epics in the same plan or IDs of existing epics in this project. `list_tasks` includes each epic’s dependency IDs. Unknown epics, self-dependencies, epic cycles and combined task/epic deadlocks are returned as plan problems naming the epics, before a version is saved.

Dependencies are stored on each plan version. A revision that keeps an epic key inherits omitted dependencies; an explicit array replaces them, including `[]` to clear them. Approval validates the graph again using each Draft’s current epic membership, including moves to epics outside the plan. A combined deadlock rejects approval with named epics and leaves tasks and dependency edges unchanged. Approval writes the snapshot to live epic dependencies atomically with task approval. Developers then wait for prerequisite epics as described in D22.

### Optimistic session starts

Send and Grill me navigate immediately to a client-generated `/plan/<id>`, with the submitted message and the PM working indicator already visible. The thread appears in navigation before the server responds. Live events and the start response replace the temporary human message without duplicating it. A failed start keeps the message labelled **Not sent**, with the error, **Retry** (same session ID) and **Back to prompt**. Back to prompt restores text, uploaded images, project, runtime and the attached task. Reloading an accepted thread uses its durable server session at the same URL.
