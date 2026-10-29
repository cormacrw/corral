# Inbox

**Canvas frames:** `App shell · Inbox`, `Inbox (component)`
**Route:** `/inbox` and `/inbox/:itemId`
**Scope:** global. Every item is tagged with its project.

## Purpose

One place for everything an agent needs you to decide, from every project, with the means to resolve it right there (D11). It works like an email client: a list on the left, the selected message on the right, and an action tray at the bottom.

Items come from two places:

- **Developer and reviewer runs:** human reviews, blocked and failed tasks, questions, and Activity.
- **Plan sessions that need you** (D11, amended 2026-10-29): each open session with a question from Juno or a plan needing approval is a **Plan thread** item. They can be handled from the Inbox or from Plan; both act on the same session. See [Plan threads](#plan-threads).

There's no separate notifications feed.

## Layout

There are three columns. The list divider can be resized (280–560px, default 380px). The task flyout docks on the right and can be resized from its own edge.

### 1. Message list

- **Search** input.
- **Filter tabs** (`UTabs`, pill): **Needs you** (with count), **Activity**, **Resolved** (with count).
  - Each tab has an icon: inbox tray, pulse, check circle.
  - Below 360px of list width the labels hide. Only icons and counts remain; the names move to tooltips and `aria-label`, e.g. "Needs you, 4".
- **Rows**, each a button:
  - an unread dot
  - the sender's avatar
  - the sender name and time (bold when unread)
  - the subject, which is the task title (bold when unread)
  - a two-line preview
  - a type badge and the project tag (a colour dot and project name)
- **Plan thread rows** look different; see [Plan threads](#plan-threads).
- The selected row uses `bg-elevated`.
- **Empty state:** "All clear. Nothing here right now."

### 2. Selected message

- **Header:**
  - the sender avatar and subject
  - the type badge, project tag, and "{sender} · {role} · {time}"
  - a **Task details** toggle (`aria-pressed`) that shows or hides the flyout
- **Body:**
  - After it's resolved, a green "Resolved" `UAlert` with what happened.
  - The agent's message in plain English.
  - Type-specific context:
    - **Human review:** the PR link (`#41`), passing-check badges, and a card of acceptance criteria. Each criterion shows a met icon, the reviewer’s note, screenshot/video/request cards, then inline markdown notes. Agent artifacts are collapsed separately; see [Evidence review](task.md#evidence-review-d21).
    - **Blocked:** the reviewer's and developer's positions side by side (2 columns, `bg-muted`).
    - **Question:** the question itself. The answers live in the tray.
    - **Activity:** one link button (Open PR, Open task…).
  - Your replies, shown as "You → Atlas" bubbles.
- **Tray**, pinned to the bottom with a top divider. This is the only place you act.
  - **Question:** "Suggested answers: Pick one, or write your own below" as radio cards in an auto-fit grid. Sending posts the chosen answer plus any note, resolves the item, and puts the task back In progress.
  - **Quick actions** (a `radiogroup` of chips; see shared pattern):

    | Item type | Actions | Needs text |
    |---|---|---|
    | Human review | ✓ Approve and merge · ✎ Request changes | Request changes only |
    | Blocked | 💬 Clarify and continue · ↩ Send back to Backlog · 🗑 Delete task (`error`) | Clarify only |

  - **Composer:**
    - The placeholder follows the selected action, e.g. "What should Atlas change?" or "Reason for deleting (optional)". With no action selected it's "Reply to {sender}…".
    - The submit button becomes labelled with the action and turns `error` for Delete.
    - Sending with no action is a plain reply to the agent.
  - Switching items clears the draft and the selected action.

### 3. Task flyout

Docked, stacked layout, from [task.md](task.md). It's open by default and closes with its own × or the Task details toggle.

## Plan threads

An open Plan session (D9) that's waiting on you, shown as an Inbox item (D11). A session is open until its plan is approved, to the board or the Backlog, or you close it with **Close thread** (it's then `closed`), and opens again when you send it a message from Plan. Closed sessions leave the Inbox; they aren't listed under Resolved.

### Where they're listed

- Only open sessions with a pending **question** or a plan **needing approval** are listed, under **Needs you**, never Activity or Resolved. They sit with the task items, newest first.
- Idle sessions, and sessions whose only news is an **unread reply**, aren't Inbox items. They stay in Plan and its side nav threads ([plan.md](plan.md#side-nav-threads)). There's no "Open in Plan" divider or group.
- The **Needs you** count includes exactly the listed threads (question or approval), plus the task items.
- `plan.session` events add, re-sort and remove threads live: a question or a new plan version adds or moves a thread up; answering its question (until Juno asks again), approving its plan or closing it, here or in Plan, removes it at once.

### Row

One button, in the same list as the other items:

- the **project dot** (in place of the sender's avatar, with the project name in its tooltip and `aria-label`)
- the **session title** (bold), and the **time** of its last message
- a **status badge**: "Needs approval" in `primary` or "Question" in `info`. While Juno is working (`activeRunId`), a spinner sits next to the time.
- a two-line **preview**: Juno's question, or the plan summary ("Plan v2 · 2 epics · 4 tasks")

### Detail pane

The selected message column shows only what needs you, **not the conversation**. The full conversation stays in Plan ([plan.md](plan.md#conversation)), one click away with **Open in Plan**.

- **Header:** the project dot and name, the session title, the status badge, the runtime badge ("Claude" or "Codex"), **Open in Plan** and **Close thread**. There's no Task details toggle; a plan's tasks open in the flyout instead.
- **Question:** Juno's question in its `info` card, with "Recommended: …" when Juno gave one, and the one-tap answers: **Accept recommendation**, one button per option, **Other…** (focuses the reply box) and **Stop and propose the plan**. Below it, a reply box ("Reply to Juno…") for a free-text answer. A tap or a sent reply sends the answer to the session and starts a PM turn, exactly as in Plan; the thread then leaves the list unless Juno asks again or proposes a plan.
- **Plan:** the plan's title, its summary and counts ("Plan v2 · 2 epics · 4 tasks"), with **View plan**, **Approve to board**, **Approve to Backlog** and **Open in Plan**. **View plan** opens the plan flyout docked on the right ([plan.md](plan.md#plan-flyout)), and a task from it opens in the task flyout.
- Earlier messages, Steps and the live turn's transcript aren't shown. While Juno is working, the pane shows a working line in place of the answers, and they're disabled.

### Actions

| Action | Shown | What it does |
|---|---|---|
| **Answer** | A question is pending | A one-tap answer, or the reply box, sends the answer to the session and starts a PM turn, as in Plan. Disabled while Juno is working. |
| **View plan** | A plan is waiting for approval | Opens the latest plan version in the docked plan flyout. |
| **Approve to board** | A plan is waiting for approval | Approves the latest plan version to the board (the plan flyout's **Add to board**). The session closes and leaves the Inbox. |
| **Approve to Backlog** | A plan is waiting for approval | Approves it to the Backlog (**Add to backlog**). The session closes and leaves the Inbox. |
| **Open in Plan** | Always | Goes to `/plan/:sessionId`, with the full conversation, keeping the thread in the side nav. |
| **Close thread** | Always | Asks for confirmation, then closes the session (below). |

- Only a human can approve (D9).
- After approving, the pane shows a green "Resolved" `UAlert` ("✓ 4 tasks added to the board.") and selection moves to the next item that needs you.

### Close thread

**Close thread** abandons a session without approving anything. It's in the thread's header here, and in the conversation header in Plan ([plan.md](plan.md#conversation)); both do the same thing.

- **Confirmation:** a modal, "Close this thread?", says what will happen: "Juno's draft tasks and the unapproved plan will be discarded. You can reopen the thread later by sending it a message from Plan." The confirm button is **Close thread** in `error`; **Cancel** keeps everything as it was. When Juno is working, the text adds "Juno's current turn will be stopped."
- **What closing does:**
  - discards the session's **Draft** tasks (deleted, as removed Drafts are; D10) and its **unapproved plan**; Backlog tasks the plan was revising are only un-staged and stay as they were
  - **stops a running PM turn**
  - marks the session `closed`
- **Afterwards:** the thread leaves the Inbox and the side nav at once (`plan.session` and `plan.drafts` events, here and in Plan), isn't listed under Resolved, and the session's drafts leave Drafts on the new-session page. Selection moves to the next item that needs you. The session stays in Plan's **Resume** list.
- **Reopening:** sending the session a message from Plan reopens it, as after an approval. The discarded drafts and plan don't come back; Juno can propose a new plan.
- **Fails:** an inline error in the pane; nothing is discarded.

### Mobile

On the mobile layout ([mobile.md](mobile.md#inbox)), a Plan thread opens as its own screen at `/inbox/:itemId`:

- **Header:** "Inbox · n of m" above the session title, a back button to the list, **Open in Plan** in place of the Task button, and a **⋯** menu with **Close thread**. The tab bar is hidden, as on any item.
- **Body:** only the question or the plan, full width, not the conversation. A question's answers are stacked, full-width buttons at least 44px tall, as in Plan on mobile, with the reply box ("Reply to Juno…") pinned below. A plan shows its title, summary and counts, with **View plan** (opens the plan in a bottom sheet; a task from it opens in a taller sheet over it) and **Approve to board** and **Approve to Backlog** side by side, full width.
- **Close thread** confirms in a bottom sheet with the same text, then returns to `/inbox`.
- Approving moves on to the next item that needs you; a failed approval keeps the screen and sheet open with the error.
- **Row:** the project dot, session title, time, status badge and preview, in the same list as the other items.

## What each action does (D10)

| Action | Task moves to | Notes |
|---|---|---|
| Answer (question) | In progress | The answer is added to the task's acceptance criteria and sent to the developer |
| Approve and merge | Merged (after gates are re-checked) | Only on Human review |
| Request changes | In progress | The text becomes the change request for the developer |
| Clarify and continue | In progress | The guidance is added to the task; the review-round counter resets |
| Send back to Backlog | Backlog | Leaves the board |
| Delete task | Soft-deleted | Stops the run, closes the PR, deletes the branch when safe; dependents become Blocked |

## Data

- **Items:** id, project, task ref, type (question / human review / blocked / failed / activity / plan thread), sender agent and role, time, subject, preview, body, unread, resolved outcome.
- **Type-specific fields:** PR, checks, criteria with evidence, positions, suggested answers. A plan thread has the session id, title, status (needs approval / question), `activeRunId`, preview and last-message time; its question and plan come from the Plan session endpoints.
- **Counts per filter.**
- New items stream in over SSE; plan threads follow `plan.session` events.

## States

- **Loading:** skeleton rows.
- **An action fails:** an inline error in the tray. The draft and selected action are kept.
- **A task changed status elsewhere:** the item shows "Already resolved" and the tray is disabled.

## Responsive

- **Below 1100px:** the flyout moves under the message.
- **Below 768px:** the list stacks above the message, and its height is capped at 360px.
- **Mobile layout** ([mobile.md](mobile.md#inbox)): the list and the item are separate screens on the same routes, and the task opens as its own page instead of the flyout.

## Accessibility

- The tabs use `role="tablist"`; quick actions use `role="radiogroup"` with `aria-checked`.
- Every icon-only control has an `aria-label`.
- Pane dividers are `role="separator"` with `aria-valuenow` and work with the arrow keys.

## Open questions

- Approve could be one click instead of select-then-send. Two steps are safer; decide after testing.
- Should Activity items expire, or stay forever?

Mobile Plan threads reuse Plan's `PlanQuestion`, composer and `PlanDetail` bottom sheet, without `PlanConversation`. The Inbox header keeps Back to Inbox and Open in Plan (the session route). A waiting plan has View plan and side-by-side approval destinations; either successful approval closes the sheet and returns to `/inbox`. Failed approvals keep the screen and sheet open.
