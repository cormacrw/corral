# Plan

**Canvas frames:** `App shell · Plan`, `Plan (component)` (the canvas still shows the plan as a card in the log; this spec moves it to the flyout)
**Route:** `/plan` (new session) and `/plan/:sessionId`
**Scope:** global. Each session belongs to one project.

## Purpose

The main place to work with Juno, the PM. Planning, refining Backlog tasks, answering PM questions and approving plans all happen here, and only here (D9, D11). Opening the page fresh should feel like starting a conversation: the composer is front and centre.

## Views

### Tab strip

A strip of tabs runs along the top of both views, listing the sessions you have open, like browser tabs.

- **Opening a tab:** opening or starting a session adds its tab at the end. Clicking a tab switches to that conversation without a full reload.
- **Each tab:** the project dot and the session title (truncated, full title on hover), then its status: a spinner while Juno is working (`activeRunId`), a `primary` dot for Needs approval, an `info` dot for Question, and a small neutral dot (with a bold title) when it's unread.
- **Closing (×):** removes only the tab. The session isn't deleted and is still in Resume and Recent. Closing the current tab moves to the tab on its right, else the one on its left, else to `/plan`.
- **+ tab:** goes to `/plan` (new session), and is the current tab there.
- **Live:** status comes from the session list in live state, which `plan.session` events keep current, so tabs update while another tab is open. No polling.
- **Persistence:** the open tabs and their order are kept in localStorage (`corral.plan.tabs`), so they survive a reload. Tabs for sessions that no longer exist are dropped when the app loads.

### New session (default when you open Plan)

Everything is centred vertically and horizontally, in a column up to 720px wide:

1. **Greeting:** Juno's avatar (a `primary`-tinted circle), "What should we plan, Cormac?", and "Juno reads {project}'s code, wiki and board before answering. Nothing reaches the board until you approve it."
2. **Composer** (large; see shared pattern): a 3-row minimum and 15px text, with a soft shadow. Toolbar, left to right:
   - **Attach** (paperclip).
   - **Project picker:** the project's colour dot, name and a chevron. Opens a listbox of projects, each with thumbnail, name, prefix and a check on the current one. It defaults to the project you were last in. It's locked once a session has messages, because a session belongs to one project.
   - **Runtime picker** (D18): which CLI Juno runs on for this session, "Claude" or "Codex". It lists only the CLIs the runner has, and remembers the last one picked (Claude until the runner answers). Like the project, it's locked once the session has messages, because an agent session only resumes on the vendor that made it: the conversation's composer shows it as a disabled button with a lock, and `PATCH /plan/sessions/:id` refuses to change it (409 `plan_session_runtime_locked`).
   - **Refine a task:** opens a searchable popover listing that project's Backlog (ref, title, epic). Picking a task attaches it as a chip at the top of the composer: "Refining COR-18 Billing settings page". The task name is a link that opens the task flyout, and an × removes the chip. With a task attached you can send without typing, and the placeholder becomes "What should change about COR-18? (optional)".
   - **Grill me:** asks Juno to question you. With an empty composer it sends "Grill me"; with a draft it sends "Grill me on this: {draft}". It's on the conversation's composer too, and is disabled while Juno is working.
   - **Resume:** opens a searchable popover of all past sessions (title and time). Picking one opens it.
   - The Enter hint and the Send button.
3. **Starter suggestions:** pill buttons that fill the composer.
   - Default: "Plan a new feature", "Break an epic into tasks", "What's blocking progress?"
   - With a task attached: "Tighten the acceptance criteria", "Split it into smaller tasks", "Check its dependencies"
4. **Recent sessions:** a bordered list of the last 4 sessions. Each row has an unread dot, the title, a status badge where there's something to do ("Needs approval" in `primary`, "Question" in `info`), the project dot and name, a one-line preview and the time. Clicking a row opens the session.

### Conversation

- **Header** (48px): the project dot and name, the session title, a neutral badge naming the session's runtime ("Claude" or "Codex"), and a **New session** ghost button.
- **Message log** (`UChatMessages`, `role="log"`), centred and up to 768px wide:
  - **Your messages:** right-aligned, in a `bg-elevated` bubble.
  - **Juno's messages:** left-aligned with the avatar and "Juno · PM".
    - **Live turn:** while Juno is working, the turn's transcript streams in at the bottom of the log as it arrives (SSE `run.events`), in the agent page's style ([agent.md](agent.md)): messages, and tool calls with their input and output collapsed into step groups. The log stays scrolled to the bottom. Until the first event arrives, a working line reads "Reading the code, wiki and board…".
    - **Past turns:** a finished turn's first message has a collapsed "Steps" disclosure above it. Opening it loads that run's saved transcript (`GET /runs/:id/transcript`) and the label becomes "N steps". The count isn't stored anywhere, so it's only known once loaded.
    - The turn's own messages (its reply, a question, a plan summary) are shown once, as messages in the log, and left out of its transcript.
  - **Questions:** Juno's questions sit in an `info`-tinted card. When Juno gave a recommendation or options, the card shows "Recommended: …" with **Accept recommendation**, one button per option, **Other…** (puts the cursor in the composer for a free-text reply) and **Stop and propose the plan** (sends "Stop asking questions and propose the plan now."). A tap sends that answer as your message straight away and starts Juno's next turn; any draft in the composer stays. Only the latest question you haven't replied to is live, and only while Juno isn't working; older and answered cards keep their buttons disabled, with the answer you gave marked (Other… for a typed reply). Questions without a recommendation or options are just the card.
  - **Plan link** (inside Juno's message, when the message proposed or revised a plan): a compact bordered button, "Plan v2 · {epic}" and "Open plan" (or "Now v3" on an older version's message). It toggles the plan flyout. The plan itself is never drawn in the log, so revisions don't stack up cards.
- **Composer:** pinned to the bottom of the conversation, with a top divider. Same tools as above; the popovers open upwards.

### Plan flyout

Docked on the right (`?plan`), the same flyout as tasks and epics; the conversation narrows to make room. It always shows the session's **latest** plan version, so each revision updates it in place. It opens by itself when a new version arrives waiting for approval, unless a task or epic is already open.

- **Header:** a "Plan v2" badge, a status badge ("Waiting for approval" in `primary`, or "Approved" in `success`), and Close.
- **Title:** the plan title and "2 epics · 4 tasks · 8 criteria" (the epic count only when there's more than one).
- **One section per epic**, in the order Juno gave them: the epic title (opens the epic), "N tasks · N criteria", and **List** / **Graph** tabs, remembered per epic.
  - **List:** one row per task: the ref and title, "N criteria · after {dependency}", and a **New** (`success`) or **Revised** (`warning`) badge. A Revised row is an existing Backlog task the plan refines by its ref; it shows the plan's proposed title, criteria and dependencies, while the task itself (opened from the row) is unchanged until approval. Rows open the task in the flyout, with a back arrow to the plan.
  - **Graph:** the epic's dependency tree, top to bottom, as on the epic flyout ([epic.md](epic.md)). A dependency in another epic shows as a dashed placeholder. Clicking a node opens the task.
  - A Draft moved to another epic by hand is listed last, under **Other tasks**.
  - Removed tasks aren't listed, and what changed lives under Changes from v1.
- **Changes from v1** (collapsed): the added and changed tasks with a change badge (Added `success`, or Revised for an existing task the revision starts refining; Changed `warning`), and "N tasks from v1 removed." Removed Drafts are deleted (D10), so only their count remains; a revised task that's removed is only un-staged and stays as it was.
- **Footer** (pinned): **Add to board** (solid primary), **Add to backlog** (outline), and "New tasks stay Drafts, and revised ones unchanged, until you choose. The board schedules them now; the Backlog keeps them for later or for refining." Afterwards it reads "✓ 4 tasks added to the board." (or "…to the Backlog").

### Task flyout

Docked on the right (see [task.md](task.md)). It opens from plan-flyout rows and from the attached-task chip. A proposed task is a **Draft**: the flyout shows a "Draft" badge and a reduced view: title, the editable properties (project, priority, type, developer, reviewer, human review), dependencies, description and acceptance criteria. There's no per-task Add to board / Add to backlog: Drafts are placed only with the whole plan, from the plan flyout. Status, branch, pull request, review round and the Activity / Evidence / History tabs are hidden, since none of them exist yet.

## Mobile

On the mobile layout ([mobile.md](mobile.md)) the same two routes keep their behaviour, laid out for a phone:

- **Session switcher:** the tab strip becomes a history button in the header. It opens a bottom sheet with **New session**, the open sessions (status badges, unread dot, spinner while Juno works, and × to close one, same rules as the tabs) and the other sessions under **Resume**.
- **New session:** the column starts at the top and scrolls. The Resume picker moves to the switcher.
- **Conversation:** full height, without the tab bar. The header shows a back button to `/plan`, the project dot and name above the session title, the switcher and **+** (new session).
- **Plan sheet:** `?plan` opens the plan in a bottom sheet instead of the flyout, with the approve buttons side by side. A task or epic opened from it opens in a taller sheet over it, whose back arrow returns to the plan. Swiping a sheet down closes it.
- **Runner offline:** an error alert, "Plan needs the runner. It's offline.", says the sessions and drafts are safe and has **Reconnect** (which re-reads the runner's status). The composer is disabled with "Juno is unavailable while the runner is offline".

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

- The tab strip is a `tablist` ("Open sessions") with one tab stop, the current tab. Left and Right arrows (wrapping), Home and End move between tabs, including +; Enter or Space opens one, and Delete closes it. Tab moves on to the current tab's close button. Close buttons are labelled "Close {title}", and the status indicators have screen-reader text.
- Popovers are listboxes with search inputs that have labels, and Escape closes them.
- The log is `aria-live="polite"`.
- The plan flyout is a `section` with an accessible name.

## Open questions

- Should editing a proposed task in the flyout create a new plan version, the way chat edits do? flows.md says no today.
- Do we need a full "All sessions" page, or is the Resume search enough?
