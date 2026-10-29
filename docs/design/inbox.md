# Inbox

**Canvas frames:** `App shell · Inbox`, `Inbox (component)`
**Route:** `/inbox` and `/inbox/:itemId`
**Scope:** global. Every item is tagged with its project.

## Purpose

One place for everything an agent needs you to decide, from every project, with the means to resolve it right there (D11). It works like an email client: a list on the left, the selected message on the right, and an action tray at the bottom.

Items come from two places:

- **Developer and reviewer runs:** human reviews, blocked and failed tasks, questions, and Activity.
- **Plan sessions that need you** (D11, amended 2026-10-29): each open session with a question from Juno, a plan needing approval or an unread reply from Juno is a **Plan thread** item. They can be handled from the Inbox or from Plan; both act on the same session. See [Plan threads](#plan-threads).

There's no separate notifications feed.

## Layout

There are three columns. The list divider can be resized (280–560px, default 380px). The task flyout docks on the right and can be resized from its own edge.

### 1. Message list

- **Search** input.
- **Filter tabs** (`UTabs`, pill): **Inbox** (with count; the Needs you list), **Activity**, **Resolved** (with count).
  - Each tab has an icon: inbox tray, pulse, check circle.
  - Below 360px of list width the labels hide. Only icons and counts remain; the names move to tooltips and `aria-label`, e.g. "Inbox, 4".
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

An open Plan session (D9) that's waiting on you, shown as an Inbox item (D11). A session is open until its plan is approved, to the board or the Backlog, or you close it with **Delete thread** here or **Close thread** in Plan (it's then `closed`), and opens again when you send it a message from Plan. Closed sessions leave the Inbox; they aren't listed under Resolved.

### Where they're listed

- Open sessions waiting on you are listed, under **Needs you**, never Activity or Resolved. There are three kinds:
  - a pending **question** from Juno (`question` holds it)
  - a plan **needing approval** (`plan` holds its summary)
  - an **unread reply**: Juno finished a turn you haven't seen, with no question or plan pending (`reply` holds that message's text). Reading the thread, here or in Plan, takes it out of the list.
- Idle sessions, with none of the three, aren't Inbox items. They stay in Plan and its side nav threads ([plan.md](plan.md#side-nav-threads)). There's no "Open in Plan" divider or group.
- **Order:** Needs you is one list of task items and threads, **newest first** by when each arrived (`at`), with no grouping or divider. The page shows it in the server's order. A task arrives when it enters Human review, Blocked or Failed (its latest transition into that status), so an update that keeps its status, such as its PR head moving, doesn't move it. A thread arrives when it started waiting: when the question was asked, the plan was proposed or the unread reply came in.
- The **Needs you** count is exactly the number of listed items: the task items and the threads.
- `plan.session` events add, re-sort and remove threads live: a question, a new plan version or a finished Juno turn adds or moves a thread up; answering its question (until Juno asks again), approving its plan, reading its reply or closing it, here or in Plan, removes it at once.

### Row

One button, in the same list as the other items, with a **Delete thread** button (trash icon, `error`) that appears on hover or keyboard focus at its bottom-right corner:

- the **project dot** (in place of the sender's avatar, with the project name in its tooltip and `aria-label`)
- the **session title** (bold), and the **time** it started waiting
- a **status badge**: "Needs approval" in `primary` or "Question" in `info`; an unread reply has the unread dot instead. While Juno is working (`activeRunId`), a spinner sits next to the time.
- a two-line **preview**: Juno's question, the plan summary ("Plan v2 · 2 epics · 4 tasks"), or Juno's reply

### Detail pane

The selected message column shows only what needs you, **not the conversation**. The full conversation stays in Plan ([plan.md](plan.md#conversation)), one click away with **Open in Plan**.

- **Header:** the project dot and name, the session title, the status badge, the runtime badge ("Claude" or "Codex"), **Open in Plan** and **Delete thread**. There's no Task details toggle; a plan's tasks open in the flyout instead.
- **Question:** Juno's question in its `info` card, with "Recommended: …" when Juno gave one, and the one-tap answers: **Accept recommendation**, one button per option, **Other…** (focuses the reply box) and **Stop and propose the plan**. Below it, a reply box ("Reply to Juno…") for a free-text answer. A tap or a sent reply sends the answer to the session and starts a PM turn, exactly as in Plan; the thread then leaves the list unless Juno asks again or proposes a plan.
- **Plan:** the plan's title, its summary and counts ("Plan v2 · 2 epics · 4 tasks"), with **View plan**, **Approve to board**, **Approve to Backlog** and **Open in Plan**. **View plan** opens the plan flyout docked on the right ([plan.md](plan.md#plan-flyout)), and a task from it opens in the task flyout.
- **Unread reply:** Juno's latest reply (`reply`), with **Open in Plan** under it and the reply box ("Reply to Juno…") below. Sending starts a PM turn, as for a question.
- Earlier messages, Steps and the live turn's transcript aren't shown. While Juno is working, the pane shows a working line in place of the answers, and they're disabled.

### Actions

| Action | Shown | What it does |
|---|---|---|
| **Answer** | A question is pending | A one-tap answer, or the reply box, sends the answer to the session and starts a PM turn, as in Plan. Disabled while Juno is working. |
| **View plan** | A plan is waiting for approval | Opens the latest plan version in the docked plan flyout. |
| **Approve to board** | A plan is waiting for approval | Approves the latest plan version to the board (the plan flyout's **Add to board**). The session closes and leaves the Inbox. |
| **Approve to Backlog** | A plan is waiting for approval | Approves it to the Backlog (**Add to backlog**). The session closes and leaves the Inbox. |
| **Open in Plan** | Always | Goes to `/plan/:sessionId`, with the full conversation, keeping the thread in the side nav. |
| **Delete thread** | Always, in the header and on the row | Removes the thread at once with an Undo toast, then closes the session (below). |

- Only a human can approve (D9).
- After approving, the pane shows a green "Resolved" `UAlert` ("✓ 4 tasks added to the board.") and selection moves to the next item that needs you.

### Delete thread

**Delete thread** abandons a session without approving anything. It's on each thread's row (on hover) and in the thread's header. It closes the session exactly as **Close thread** in Plan's conversation header ([plan.md](plan.md#conversation)) does, but with Undo instead of a confirmation.

- **No confirmation:** the row leaves the list at once and a toast says "Thread deleted · its drafts were discarded", with **Undo**, for 5 seconds. Deleting the selected thread moves selection to the next item, as resolving does.
- **Undo** within the 5 seconds cancels the close: the row comes back and nothing was discarded.
- When the toast runs out, the page calls `POST /plan/sessions/:id/close`. The pending delete lives outside the page (`usePlanThreadDelete`), so leaving the Inbox doesn't cancel it, and one still pending when the tab closes or reloads is sent then (a `keepalive` request).
- **What closing does:**
  - discards the session's **Draft** tasks (deleted, as removed Drafts are; D10) and its **unapproved plan**; Backlog tasks the plan was revising are only un-staged and stay as they were
  - **stops a running PM turn**
  - marks the session `closed`
- **Afterwards:** the thread leaves the Inbox and the side nav at once (`plan.session` and `plan.drafts` events, here and in Plan), isn't listed under Resolved, and the session's drafts leave Drafts on the new-session page. Selection moves to the next item that needs you. The session stays in Plan's **Resume** list.
- **Reopening:** sending the session a message from Plan reopens it, as after an approval. The discarded drafts and plan don't come back; Juno can propose a new plan.
- **Fails:** an error toast, and the row comes back; nothing is discarded.

### Mobile

On the mobile layout ([mobile.md](mobile.md#inbox)), a Plan thread opens as its own screen at `/inbox/:itemId`:

- **Header:** "Inbox · n of m" above the session title, a back button to the list, **Open in Plan** in place of the Task button, and a **⋯** menu with **Delete thread**. The tab bar is hidden, as on any item.
- **Body:** only the question or the plan, full width, not the conversation. A question's answers are stacked, full-width buttons at least 44px tall, as in Plan on mobile, with the reply box ("Reply to Juno…") pinned below. An unread reply shows Juno's latest reply with the same reply box. A plan shows its title, summary and counts, with **View plan** (opens the plan in a bottom sheet; a task from it opens in a taller sheet over it) and **Approve to board** and **Approve to Backlog** side by side, full width.
- **Delete thread** doesn't ask first. It returns to `/inbox` without the thread and offers **Undo**, as a swipe does (below).
- Approving returns to `/inbox`; a failed approval keeps the screen and sheet open with the error.
- **Row:** the project dot, session title, time, status badge and preview, in the same list as the other items. The first tab is named **Inbox** (the web's Needs you), newest first, with no group for threads.
- **Swipe to delete:** swiping a thread row left reveals a red **Delete** button; a full swipe deletes at once, and a short one snaps back. Task items don't swipe. Deleting removes the row immediately and shows a "Thread deleted" toast with **Undo** for 5 seconds; only then is the thread closed (as [Close thread](#close-thread), discarding its drafts and unapproved plan). Undo puts the row back with nothing discarded. If the close fails, the row comes back with an error toast. `useDeletePlanThread` holds the pending deletes, so a delete started on the thread screen carries on after it returns to the list.

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
- **Type-specific fields:** PR, checks, criteria with evidence, positions, suggested answers. A plan thread has the session id, title, status (needs approval / question / none with an unread reply), `activeRunId`, preview, `reply` and the time it started waiting; its question and plan come from the Plan session endpoints.
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

Mobile Plan threads reuse Plan's `PlanQuestion`, composer and `PlanDetail` bottom sheet, without `PlanConversation`. `InboxMobile` renders its focused Plan thread through `InboxMobilePlanThread`; the Inbox header keeps Back to Inbox and Open in Plan (the session route), with Delete thread in the overflow menu. Deleting returns to `/inbox` at once and closes the session after the 5-second Undo toast (`useDeletePlanThread`); list rows use `SwipeToDelete` for the same action. A waiting plan has View plan and side-by-side approval destinations. The thread provides `FLYOUT_SHEETS`, so `useTaskFlyout` keeps a task or epic opened from the plan sheet on the Inbox route (`?task=`/`?epic=`) in a taller sheet over the plan, and dismissing it goes back to the plan; either successful approval closes the sheet and returns to `/inbox`. Failed approvals keep the screen and sheet open.
