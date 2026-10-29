# Inbox

**Canvas frames:** `App shell · Inbox`, `Inbox (component)`
**Route:** `/inbox` and `/inbox/:itemId`
**Scope:** global. Every item is tagged with its project.

## Purpose

One place for everything an agent needs you to decide, from every project, with the means to resolve it right there (D11). It works like an email client: a list on the left, the selected message on the right, and an action tray at the bottom.

**Only developer and reviewer runs create Inbox items.** PM questions and plan approvals live in Plan. There's no separate notifications feed.

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

- **Items:** id, project, task ref, type (question / human review / blocked / failed / activity), sender agent and role, time, subject, preview, body, unread, resolved outcome.
- **Type-specific fields:** PR, checks, criteria with evidence, positions, suggested answers.
- **Counts per filter.**
- New items stream in over SSE.

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
