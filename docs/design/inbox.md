# Inbox

**Canvas frames:** `App shell · Inbox`, `Inbox (component)`
**Route:** `/inbox` and `/inbox/:itemId`
**Scope:** global. Items are tagged with their project, or **Global** for global Plan threads and PM activity about the factory.

## Purpose

One place for everything an agent needs you to decide, from every project, with the means to resolve it right there (D11). It works like an email client: a list on the left, the selected message on the right, with its actions and a composer.

Items come from two places:

- **Developer and reviewer runs:** human reviews, blocked, failed and stopped tasks, questions, and Activity.
- **Plan sessions that need you** (D11): each open session with a question from Juno, a plan needing approval or a failed Juno turn is a **Plan thread** item. They can be handled from the Inbox or from Plan; both act on the same session. A session with only an unread reply is informational and stays in Plan. See [Plan threads](#plan-threads).

There's no separate notifications feed.

A criterion marked **Checked by a human** always sends an approved task here, even if its task-level human-review flag is off, except a PR-free sub-task, whose checks appear on the parent review. Its evidence card says **Needs human check** and has a checkbox for the human. Tick every such criterion, in the **Criteria** tab, before **Approve and merge**; approving with one unticked sends nothing, opens that tab and says each check must be ticked. Requesting changes remains available. These ticks are local to the selected item; approval uses the usual merge gates.

## Layout

There are three columns. The list divider can be resized (280–560px, default 380px). The task flyout docks on the right and can be resized from its own edge.

### 1. Message list

- **Search** input.
- **Filter tabs** (`UTabs`, pill): **Inbox** (with count; the Needs you list, decisions only), **Activity** (agent progress and release notes, read on demand, with no count), **Resolved** (with count).
  - Each tab has an icon: inbox tray, pulse, check circle.
  - Below 360px of list width the labels hide. Only icons and counts remain; the names move to tooltips and `aria-label`, e.g. "Inbox, 4".
- **Rows**, each a button:
  - an unread dot
  - the sender's avatar
  - the sender name and time (bold when unread)
  - the subject, which is the task title (bold when unread), prefixed with what the item is in muted text: **Task Review**, **Question**, **Blocked**, **Failed**, **Stopped**, **Plan Review**, **Parent Review**, **Conflict**, **Runner Update** or **Activity** (`inboxTitlePrefix`). Release notes have no prefix; their subject says it already.
  - a two-line preview
  - the project tag (a colour dot and project name)
  - no badges or tags beyond these
- **Plan thread rows** have the same layout; see [Plan threads](#plan-threads).
- The selected row uses `bg-muted`.
- **Empty state:** the Inbox tab says "No decisions are waiting on you. Agents may still be working; their updates are in Activity." It never implies that background work has finished. The detail pane says the same with **Open Activity**. Activity, Resolved and a search with no matches each have their own line.
- **Live updates:** an informational item arriving adds no Inbox row, doesn't change the count or badge, and doesn't move the selection. It appears under Activity.
- **A link to an item:** an informational item opens with the list on Activity, and a resolved one on Resolved. A link to something no longer listed shows "This isn't waiting on you any more", with **Open Activity** and, when known, its source: **Open in Plan**, **Open task** or **Open parent**. It's never presented as a new request.

### 2. Selected message

Task items (human review, question, blocked, failed, stopped, Activity and Resolved) use **Option D** (`InboxPanel`, with `useInboxPanel` deriving what it shows). What's needed to decide sits up front, and everything else is one click away in tabs. On a phone the actions and composer move to a bottom bar ([mobile.md](mobile.md#inbox)). Plan threads, parent items and release notes have their own layouts.

- **Top block**, which fits at 1280×800 without scrolling:
  - the title, with one quiet line (`InboxPanelMeta`) under it: kind (Code, Design or Spike review, Question, Blocked, Failed, Stopped, Activity, Resolved) · project · ref · sender · time. Parent items and Plan threads put the same line under their titles. The flyout is closed whenever an item opens.
  - shared `InboxMessage` in place of a TL;DR: the short `message` clamped to three lines. Items with no message show **TL;DR** and the first paragraph of the body, cut to two lines.
  - the verdict on reviews (`InboxPanelVerdict`): reviewer and round, gates passed, criteria met. It's red only when a criterion is unmet; a human check waiting for its tick isn't unmet.
  - the links (`InboxPanelArtifacts`): **PR #n**, or **Preview vN** and **Review design** on a design, then **Task {ref}** (`aria-pressed`), which opens the task in the docked flyout with one click and closes it with another. Spikes have no PR link. On a phone, which has no flyout, Activity has **Open task** or **Open parent** instead.
- **Bottom bar**, pinned to the bottom of an item you can act on: the actions (`InboxPanelActions`), with the composer above them once an action opens it (below).
- **Tabs:** **Overview · Criteria n/m · Review · PR description · Code diff N · Message**. Criteria and Review show on reviews that have them. The tab resets when another item opens. A panel with only one tab shows no tab bar (`InboxPanelLayout`).
  - **Overview:** on a review, a screenshot carousel (`InboxEvidenceCarousel`): one large screenshot at a time, with "n of m", arrows and a swipe on phones. The other files follow it. One click opens any of them in the evidence viewer, which flips through all of the review's files, screenshots first, with its own arrows, the arrow keys or a swipe. Closing it leaves the carousel, and focus, on the last screenshot viewed. The Criteria tab's viewer flips through its files the same way. On other items, or a review with no evidence, what each action does. A read-only item shows its resolution, or "For your information. Nothing to do."
  - **Criteria:** `EvidenceList`, with its notes, evidence and human checks.
  - **Review:** every round's verdict and summary, newest first.
  - **Message:** the full `body`, including spike findings.
  - **PR description, Code diff:** show on an item with a PR, once its task says it isn't a design or spike, whatever the item's type. N is the PR's changed files, and is left off until the PR arrives. Each file shows its additions and deletions and opens to its diff, the first starting open. Past the [cap](../../.corral/wiki/pull-request-detail.md), the tab says how much is shown and links to the PR on GitHub. If the PR can't be loaded, both tabs show the error with **Retry** and the rest of the panel carries on.
- **Actions:**

  | Item | Actions | One click |
  |---|---|---|
  | Human review | Approve and merge (Accept findings on spikes, Approve design on designs) · Request changes | Approve sends with no note, and the Inbox moves on. An unmet criterion doesn't stop it. |
  | Question, Blocked | Answer · Send back to Backlog · Delete task | Send back sends |
  | Failed | Retry, with its status picker beside it · Send back to Backlog · Delete task | Retry and Send back send, Retry with whatever note is in the composer. An empty note still retries. |
  | Stopped | Retry · Give direction · Send back to Backlog · Delete task | Retry and Send back send |
  | Activity, Resolved | None, and no composer | |

  **Request changes**, **Answer**, **Give direction** and **Delete task** open the composer instead, with **Cancel** above it. Delete waits for it because it can't be undone, and takes an optional reason.
- **Composer** (`InboxPanelTray`, on the shared `PromptComposer`, built on shadcn's input group), just above the actions: it's only for actions, so it's hidden until one that takes words is chosen, and closes on **Cancel** or once sent. There's no reply box: a comment belongs on the task. A failed item opens on Retry: the composer is labelled **Note to send with Retry (optional)**, its hint says the note guides the agent's next run, and its send button retries with the chosen status. Cancelling any action on a failed item returns to the Retry note.

### What each kind shows

- Needs-you task and parent items show the short `message` from shared `InboxMessage`, with no row of files under it: a review's files are in the Overview tab's carousel and the Criteria tab. Evidence is untrusted, so the viewer never frames HTML: images, video and text show in the app, a PDF in an iframe, and anything else is a download link.
- The complete `body`, including spike findings, is in the **Message** tab, and the tab resets when another item opens. Items without `message` keep their existing rendering, including Plan threads, release notes, Activity and Resolved.
- **Spikes always stop in Human review**, whatever their human-review flag says. They appear under Needs you and add one to its count. The **Message** tab renders the latest `## Findings` comment as markdown; criteria verdicts and evidence remain below it. Desktop and mobile label approval **Accept findings**, keep **Request changes**, and hide PR links and check badges. The success toast and Resolved entry say **You accepted the findings**. The preview is the start of the short message; approval finishes the spike in Merged; requesting changes returns it to the developer with the feedback.
- **Designs** use **Approve design** on desktop and mobile. Approval marks the latest submitted version Approved, supersedes earlier versions and moves the task to Approved, then advances to the next item. There is no PR to merge; approval opens a Plan session and starts the PM’s build-planning turn.

PM activity can have no task, including activity for a deleted task. It keeps its project tag (or **Global**) and PM conversation link in the **Message** tab, with no **Open task** or **Task {ref}** controls and no task-loading error. This applies on desktop and mobile.

### 3. Task flyout

Docked, stacked layout, from [task.md](task.md). It's closed when an item opens, including when acting moves on to the next one; the **Task {ref}** button beside the PR link opens it, and it closes with its own × or the same button. A shared link with `?task=` still opens it.

## Plan threads

An open Plan session (D9) that's waiting on you, shown as an Inbox item (D11). A session is open until its plan is approved, to the board or the Backlog, or you close it with **Delete thread** here or **Close thread** in Plan (it's then `closed`), and opens again when you send it a message from Plan. Closed sessions leave the Inbox; they aren't listed under Resolved.

### Where they're listed

- Open sessions with a decision are listed under **Needs you**:
  - a pending **question** from Juno (`question` holds it)
  - a plan **needing approval** (`plan` holds its summary)
  - a **failed turn**: Juno's last turn ended in an error and nothing will retry it (`failure` holds the error). Reading doesn't clear it; messaging the session or deleting the thread does.
- A session with only an **unread reply** is informational: it isn't listed and doesn't count, and the conversation stays in Plan.
- Idle sessions, with none of the three, aren't Inbox items. They stay in Plan and its side nav threads ([plan.md](plan.md#side-nav-threads)). There's no "Open in Plan" divider or group.
- **Order:** Needs you is one list of task items, threads and parent items, **newest first** by when each arrived (`at`), with no grouping or divider. The page shows it in the server's order. A task arrives when it enters Human review, Blocked or Failed (its latest transition into that status), so an update that keeps its status, such as its PR head moving, doesn't move it. A stopped task keeps its working status and arrives when the run that stopped it ended. A thread arrives when it started waiting: when the question was asked, the plan was proposed or the turn failed.
- The **Needs you** count is every listed item. Global, project and mobile counts all come from this list.
- `plan.session` events add, re-sort and remove threads live: a question, a new plan version or a failed turn adds or moves a thread up; answering its question (until Juno asks again), approving its plan, messaging it after a failed turn or closing it, here or in Plan, removes it at once.

### Row

One button, in the same list as the other items, with no delete control on a wide screen:

- the **sender's avatar** and **name** (Juno, under the PM's current name), with the **time** it started waiting. While Juno is working (`activeRunId`), a spinner sits next to the time.
- the **session title** (bold)
- a two-line **preview**: Juno's question, the plan summary ("Plan v2 · 2 parents · 4 tasks"), or the failed turn's error
- the **project tag** (a thumbnail and the project name), with no status badge: the title's prefix (**Plan Review**, **Question** or **Failed**) says why it's here. The unread dot sits before the avatar while the turn is unseen.

### Detail pane

The selected message column shows only what needs you, **not the conversation**. The full conversation stays in Plan ([plan.md](plan.md#conversation)), one click away with **Open in Plan**.

It shares the task panel's frame (`InboxPanelLayout`), so a plan to approve reads like a task to review.

- **Header:** the session title with the `InboxPanelMeta` line (Plan review, Question or Failed · project · sender · time) under it, "Runs on Claude" or "Codex", then **Open in Plan**. There's no Task button; a plan's tasks open in the flyout instead.
- **Question:** Juno's question in its `info` card, with "Recommended: …" when Juno gave one, and the one-tap answers: **Accept recommendation**, one button per option, **Other…** (focuses the reply box) and **Stop and propose the plan**. Below it, a reply box ("Reply to Juno…") for a free-text answer. A tap or a sent reply sends the answer to the session and starts a PM turn, exactly as in Plan; the thread then leaves the list unless Juno asks again or proposes a plan.
- **Plan:** the whole plan in the body (`PlanDetailBody`, shared with the plan flyout): its title (left out when it matches the session title), counts and summary, its tasks under each parent as a list or graph, and what changed since the previous version. A task opens in the task flyout. At the bottom, as on a task review: **Approve to board**, **Approve to Backlog** and **Request changes**, which opens the composer ("What should Juno change?") above them; sending it starts a PM turn.
- **Failed turn:** what happened and the turn's error (`failure`), with **Open in Plan** under it and the reply box ("Reply to Juno…") below. Sending starts a PM turn, as for a question.
- Earlier messages, Steps and the live turn's transcript aren't shown. While Juno is working, the pane shows a working line in place of the answers, and they're disabled.

### Actions

| Action | Shown | What it does |
|---|---|---|
| **Answer** | A question is pending | A one-tap answer, or the reply box, sends the answer to the session and starts a PM turn, as in Plan. Disabled while Juno is working. |
| **Approve to board** | A plan is waiting for approval | Approves the latest plan version to the board (the plan flyout's **Add to board**). The session closes and leaves the Inbox. |
| **Approve to Backlog** | A plan is waiting for approval | Approves it to the Backlog (**Add to backlog**). The session closes and leaves the Inbox. |
| **Request changes** | A plan is waiting for approval | Opens the composer; what's sent goes to the session and starts a PM turn. |
| **Open in Plan** | Always | Goes to `/plan/:sessionId`, with the full conversation, keeping the thread in the side nav. |
| **Delete thread** | Always, last in the bottom bar's actions | Removes the thread at once with an Undo toast, then closes the session (below). |

- Only a human can approve (D9).
- After approving, the pane shows a green "Resolved" `AppAlert` ("✓ 4 tasks on the board.") and selection moves to the next item that needs you.

### Delete thread

**Delete thread** abandons a session without approving anything. It's with the other actions at the bottom of the thread. It closes the session exactly as **Close thread** in Plan's conversation header ([plan.md](plan.md#conversation)) does, but with Undo instead of a confirmation.

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
- **Body:** only the question or the plan, full width, not the conversation. A question's answers are stacked, full-width buttons at least 44px tall, as in Plan on mobile, with the reply box ("Reply to Juno…") pinned below. A failed turn shows its error with the same reply box. A plan shows its title, summary and counts, with **View plan** (opens the plan in a bottom sheet; a task from it opens in a taller sheet over it) and **Approve to board** and **Approve to Backlog** side by side, full width.
- **Delete thread** doesn't ask first. It returns to `/inbox` without the thread and offers **Undo**, as a swipe does (below).
- Approving returns to `/inbox`; a failed approval keeps the screen and sheet open with the error.
- **Row:** the sender's avatar, name and time, the session title, the preview, and the status badge beside the project tag, in the same list as the other items. The first tab is named **Inbox** (the web's Needs you), newest first, with no group for threads.
- **Swipe to delete:** swiping a thread row left reveals a red **Delete** button; a full swipe deletes at once, and a short one snaps back. Task items don't swipe. Deleting removes the row immediately and shows a "Thread deleted · its drafts were discarded" toast with **Undo** for 5 seconds; only then is the thread closed (as [Delete thread](#delete-thread), discarding its drafts and unapproved plan). Undo puts the row back with nothing discarded. If the close fails, the row comes back with an error toast. `usePlanThreadDelete` holds the pending deletes, shared with desktop, so a delete started on the thread screen carries on after it returns to the list or the layout changes. Reloading or closing the tab during Undo sends the close immediately with a keepalive request.

### Parent items (D27)

A parent rebase's question (D27, COR-291) is a task question whose Overview leads with the question, any binding decision, each alternative with its effect and a **Choose** button, and the affected changes. Choosing resumes the rebase; **Answer** writes a free-form answer, which counts as a behaviour change.

Every parent item uses `InboxEpicPanel`, Option D for a parent, on desktop and mobile: a parent PR waiting on the human, what stopped a parent, and the read-only moments in Activity and Resolved. It reads `GET /api/epics/:id/review`. The top block shows at once, from the item, with skeletons in the tab body until the review arrives.

- **Up front:** the kind, project, sender and time, the parent's name linking to it, and `InboxMessage` (a TL;DR with no message). On a review the verdict reads **Rita approved the parent · lint, test passed · 3 of 3 tasks merged · You saw 1 of 3**, or says there's no reviewer approval on this head when the review stopped or a merge was refused. *You saw* counts tasks that had their own human review. Then the actions and the parent PR's link. A line under the actions names the target branch, how many commits it has moved when it has, and that approving runs CI and squash-merges; with a pending conflict (D27) it says approving sends the conflict to a developer first.
- **Tabs:** Overview · Tasks n/m · Review · PR description · Code diff N · Message.
- **Overview:** a later round leads with **Since your last review**, quoting the human's feedback and naming its fix tasks, with **See only these changes**. Then non-blocking notes, screenshots labelled by task, then the review mode and size. With no screenshots, only the notes and the size. A first review has no such block.
- **Tasks:** one row per task with who passed it, criteria met, its PR or, for a PR-free task, its commit, and whether it's a **Fix task** or **Conflict task**. A row opens the task. Owed human checks are ticked here. Conflict and CI fixes have no task (D29), so these labels come from a human's Request changes, or from before D29.
- **Review:** the integration findings first, then the reviewer's summary, for every round, newest first.
- **Code diff:** switches between **Since your last review** and **Whole parent** in a later round. After a rebase a file's patch is its whole change on the parent, not the change since.
- **Approve parent:** one click when nothing is owed, and the Inbox moves on. A non-blocking note doesn't ask for confirmation. With checks owed it opens Tasks, says what's left, and sends only once all are ticked.
- **Request changes:** opens the composer, and its text becomes a fix task in Ready in the parent, titled by `feedbackFixTitle`.
- **The head moved while open:** the action carries the head the human was looking at, so it fails with a message, the feedback text is kept and the panel refreshes. If the item leaves the Inbox while open, the panel stays on it with the message and nothing can be sent.
- **What stopped a parent:** an `epic_conflict` item shows the failure, the conflicting files or the rebase's question. **Retry** goes round the automatic path again; a question is answered with a **Choose** button or in the composer.
- **Read-only:** opened, conflict, approved and merged items show *For your information. Nothing to do.* in place of the actions, and Resolved items show the resolution. A merged parent shows its squash commit, and an approved one says what happens next. The Activity record of a conflict links its task and shows tasks merged, such as 2 of 3, only when a task exists.

## What each action does (D10)

| Action | Task moves to | Notes |
|---|---|---|
| Answer (question) | In progress | The answer is added to the task's acceptance criteria and sent to the developer |
| Approve and merge / Accept findings | Merged (PR gates are re-checked for non-spikes) | Only on Human review; spikes finish without a merge |
| Request changes | In progress | The text becomes the change request for the developer |
| Answer (blocked) | In progress | The guidance is added to the task; the review-round counter resets |
| Send back to Backlog | Backlog | Leaves the board |
| Delete task | Soft-deleted | Stops the run, closes the PR, deletes the branch when safe; dependents become Blocked |

## Data

- **Items:** id, project, task ref, type (question / human review / blocked / failed / stopped / activity / plan thread), sender agent and role, time, subject, preview, body, unread, resolved outcome.
- **Type-specific fields:** PR, checks, criteria with evidence, positions, suggested answers. A plan thread has the session id, title, status (needs approval / question / failed), `activeRunId`, preview, `failure` and the time it started waiting; its question and plan come from the Plan session endpoints.
- **What changed since the last review:** a needs-you task or parent item carries `since` and `newArtifacts`. `since` is null until the human has acted, then holds when they last requested changes or answered, what they said, the developers' one-line notes after it, and a parent's fix tasks. `newArtifacts` lists the files added after that action, plus a design's latest version with its preview link, and on a parent each file names its task. Before any action everything is new. Written (`note`) evidence is never listed. Actions and artifacts are compared by time, because review rounds reset when a task is resolved.
- **Counts per filter.**
- New items stream in over SSE; plan threads follow `plan.session` events.

## States

- **Loading:** skeleton rows in the list. An item's top block shows at once from the Inbox data, with skeletons for its verdict and tab body until the task and its evidence arrive; Approve reads **Loading task…** and the actions wait.
- **An action fails:** an inline error above the composer, or above the action bar on a phone with the composer closed. The draft is kept, and an action that opens the composer stays chosen.
- **The task fails to load:** an inline error at the end of the top block with **Retry**, instead of a spinner. Approval stays blocked, because its human-criteria check needs the task, and its action reads **Task not loaded**. The other actions still work.
- **A task changed status elsewhere:** the item shows "Already resolved. This task changed status elsewhere." in Overview, with no actions and no composer, and no action bar on a phone.

## Responsive

- **Below 1100px:** the flyout moves under the message.
- **Below 768px:** the list stacks above the message, and its height is capped at 360px.
- **Mobile layout** ([mobile.md](mobile.md#inbox)): the list and the item are separate screens on the same routes, and the task opens as its own page instead of the flyout.

## Accessibility

- The tabs use `role="tablist"`. Actions are plain buttons named with their full label, so a phone's **Send back** is announced as "Send back to Backlog".
- Every icon-only control has an `aria-label`.
- Pane dividers are `role="separator"` with `aria-valuenow` and work with the arrow keys.

## Open questions

- Should Activity items expire, or stay forever?

Mobile Plan threads reuse Plan's `PlanQuestion`, composer and `PlanDetail` bottom sheet, without `PlanConversation`. `InboxMobile` renders its focused Plan thread through `InboxMobilePlanThread`; the Inbox header keeps Back to Inbox and Open in Plan (the session route), with Delete thread in the overflow menu. Deleting returns to `/inbox` at once and closes the session after the 5-second Undo toast (`usePlanThreadDelete`); list rows use `SwipeToDelete` for the same action. A waiting plan has View plan and side-by-side approval destinations. The thread provides `FLYOUT_SHEETS`, so `useTaskFlyout` keeps a task or parent opened from the plan sheet on the Inbox route (`?task=`/`?parent=`) in a taller sheet over the plan, and dismissing it goes back to the plan; either successful approval closes the sheet and returns to `/inbox`. Failed approvals keep the screen and sheet open.

## Release notes (COR-129)

The latest 20 deployments appear as Release notes from the configured PM, with its avatar, project, time and short commit range. Undismissed notes are listed under **Activity** by deployment time, read or unread (D11). They never appear in the default Inbox tab or add to its badge or count, so they need no dismissing. An unread dot stays until the item is opened, on desktop or mobile. Reading keeps the item in Activity; the optional Dismiss moves it to Resolved.

The shared detail pane renders markdown with task references linking to `/tasks/:ref`, and shows the commit range (or the first-deploy commit). Pending notes show “Writing release notes…” and refresh on `deployment.updated`, without a reload. Mobile uses its regular back header and the same detail pane, without a task-details button or reply composer.
