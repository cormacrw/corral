# Inbox

**Canvas frames:** `App shell · Inbox`, `Inbox (component)`
**Route:** `/inbox` and `/inbox/:itemId`
**Scope:** global. Every item is tagged with its project.

## Purpose

One place for everything an agent needs you to decide, from every project, with the means to resolve it right there (D11). It works like an email client: a list on the left, the selected message on the right, and an action tray at the bottom.

Items come from two places:

- **Developer and reviewer runs:** human reviews, blocked and failed tasks, questions, and Activity.
- **Open Plan sessions** (D11, amended 2026-10-29): each open session is a **Plan thread** item, so Juno's questions, plans waiting for approval and unread replies are here too. They can be handled from the Inbox or from Plan; both act on the same session. See [Plan threads](#plan-threads).

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
    - **Human review:** the PR link (`#41`), passing-check badges, and a card of acceptance criteria. Each criterion shows a met icon, a note on how it was checked, and an evidence thumbnail (screenshot, video or test output) that opens a viewer.
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

An open Plan session (D9) shown as an Inbox item (D11). A session is open until its plan is approved, to the board or the Backlog (it's then `closed`), and opens again when you send it a message. Closed sessions leave the Inbox; they aren't listed under Resolved.

### Where they're listed

- Every open session is under **Needs you**, never Activity or Resolved.
- Sessions that need you (a plan **needing approval**, a **question** or an **unread reply**, the same reasons as the side nav threads in [plan.md](plan.md#side-nav-threads)) are listed with the task items, newest first.
- The other open sessions are sorted below everything that needs you, newest first, under a quiet "Open in Plan" divider.
- The **Needs you** count includes only the sessions that need you (approval, question or unread reply), matching the Plan badge.
- `plan.session` events add, re-sort and remove threads live: a question or a new plan version moves a thread up; approving its plan, here or in Plan, removes it at once.

### Row

One button, in the same list as the other items:

- the **project dot** (in place of the sender's avatar, with the project name in its tooltip and `aria-label`)
- the **session title** (bold when it needs you), and the **time** of its last message
- a **status badge**: "Needs approval" in `primary`, "Question" in `info`, or "Unread reply" (neutral). Open sessions with nothing to do have no badge. While Juno is working (`activeRunId`), a spinner sits next to the time.
- a two-line **preview** of the latest message: Juno's question, the plan summary ("Plan v2 · 2 epics · 4 tasks"), or the last reply

### Detail pane

The selected message column shows the session's **conversation**, the same one as Plan's ([plan.md](plan.md#conversation)), not a copy:

- **Header:** the project dot and name, the session title, the status badge, the runtime badge ("Claude" or "Codex"), and **Open in Plan**. There's no Task details toggle; a plan's tasks open in the flyout instead.
- **Body:** the message log, scrolled to the bottom: your messages, Juno's messages with their collapsed Steps, question cards and Plan links. While Juno is working, the live turn streams in, as in Plan. A Plan link, or a task from the plan, opens in the docked flyout (the plan flyout and task flyout from [plan.md](plan.md#plan-flyout)).
- Selecting a thread with an unread reply marks it read, as opening the session in Plan does.

### Actions

In the tray, as for other items:

| Action | Shown | What it does |
|---|---|---|
| **Reply** | Always | The composer ("Reply to Juno…") sends a message to the session and starts a PM turn, exactly as in Plan. On a question, the card's buttons (Accept recommendation, an option, Other…, Stop and propose the plan) send the answer straight away. Disabled while Juno is working. |
| **Approve to board** | A plan is waiting for approval | Approves the latest plan version to the board (the plan flyout's **Add to board**). The session closes and leaves the Inbox. |
| **Approve to Backlog** | A plan is waiting for approval | Approves it to the Backlog (**Add to backlog**). The session closes and leaves the Inbox. |
| **Open in Plan** | Always | Goes to `/plan/:sessionId`, keeping the thread in the side nav. |

- Approve to board and Approve to Backlog are quick-action chips; like the others, selecting one labels the submit button ("Approve to board ↑") and sending carries it out. Only a human can approve (D9).
- After approving, the pane shows a green "Resolved" `UAlert` ("✓ 4 tasks added to the board.") and selection moves to the next item that needs you.

### Mobile

On the mobile layout ([mobile.md](mobile.md#inbox)), a Plan thread opens as its own screen at `/inbox/:itemId`:

- **Header:** "Inbox · n of m" above the session title, a back button to the list, and **Open in Plan** in place of the Task button. The tab bar is hidden, as on any item.
- **Body:** the conversation, full width, scrolled to the bottom. Question answers are stacked, full-width buttons at least 44px tall, as in Plan on mobile. A Plan link opens the plan in a bottom sheet; a task from it opens in a taller sheet over it.
- **Tray:** **Approve to board** and **Approve to Backlog** side by side, full width, when a plan waits for approval, above the composer ("Reply to Juno…"). Approving moves on to the next item that needs you.
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
- **Type-specific fields:** PR, checks, criteria with evidence, positions, suggested answers. A plan thread has the session id, title, status (needs approval / question / unread reply / none), `activeRunId`, preview and last-message time; its messages and plan come from the Plan session endpoints.
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

Mobile Plan threads reuse `PlanConversation` with Plan's `PlanQuestion`, composer and `PlanDetail` bottom sheet. The Inbox header keeps Back to Inbox and Open in Plan (the session route). A waiting plan has View plan and side-by-side approval destinations above the composer; either successful approval closes the sheet and returns to `/inbox`. Failed approvals keep the conversation and sheet open.
