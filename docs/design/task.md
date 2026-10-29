# Task flyout and task page

**Canvas frames:** `Task flyout · docked, stacked`, `Task page · split`
**Component:** one `TaskDetail` component with three modes.

| Mode | Where | Layout |
|---|---|---|
| `flyout` | Docked on the right of Inbox, Plan, Board, Backlog and Agent pages | Stacked, one column, resizable 360–960px (default 420px) |
| `page` | `/tasks/:ref`, e.g. `/tasks/COR-29` | Split: content on the left, a 260px properties rail on the right, centred up to 1200px |
| `mobile` | `/tasks/:ref` under the mobile layout | A full page with Details and Criteria and activity tabs, see [mobile.md](mobile.md#task-and-epic) |

The flyout opens with `?task=COR-29` on the current page's URL, so it survives reloads and links can be shared. Pages decide what opens it (a row click, a card click, a chip link). Clicking the same row again closes it. Opening a task or epic adds a browser history entry, so Back returns to whatever the flyout showed before (an epic, after opening one of its tasks). The Inbox, which opens the selected item's task by itself, replaces the entry instead. Closing the flyout doesn't add one.

## Purpose

Read and edit any task from wherever you are, without losing your place. It's the most reused component in the app, so it has to be consistent everywhere.

## Structure

### Header (56px, bottom border)

- **Flyout:** a back arrow when this task was opened from another flyout item (an epic's task list or graph, or another task), then a breadcrumb (`text-muted`) on the left: the task's epic, which opens the epic in the flyout, › the task ref, then a "✓ Saved" note for 1.8s after any edit. On the right: copy link, open full page, close.
- **Page:** a breadcrumb (`Board › {epic} › COR-29`, the epic linking to its page) with no close or open-full-page buttons.
- **No status badge in the header.** Status lives in the properties.

### Body, in order (stacked; split mode moves the properties to the rail)

1. **Title:** an inline-editable input, 18px semibold. A borderless field that shows a background on hover and a `primary` ring on focus.
2. **Properties.** In stacked mode each row is a label (104px) and a value; in split mode the label sits above the value.

   | Property | Control | Editable |
   |---|---|---|
   | Project | text | No |
   | Status | `USelectMenu` with a colour dot | Only the moves a human may make under D10 (e.g. Blocked → Backlog / Ready / In progress). Otherwise read-only, with the tooltip "Set by agents while they work" |
   | Priority | `USelectMenu`: Urgent, High, Medium, Low | Yes |
   | Epic | `USelectMenu` | Yes |
   | Developer | `USelectMenu` with avatar: a named agent or "Any available developer" | Yes |
   | Reviewer | `USelectMenu` with avatar: a named agent or "Any available reviewer" | Yes |
   | Human review | `USwitch` | Yes (D5) |
   | Branch | mono text | No |
   | Pull request | link, or "Not opened yet" | No |
   | Review round | text, e.g. "2 of 5" | No |

   - Dropdowns are Nuxt UI `USelectMenu`, never native `<select>`.
   - The trigger is borderless with a chevron and gets `bg-elevated` on hover or while open.
   - The menu uses popover styling, with a trailing `primary` check on the selected item.
   - Picking an option saves immediately and shows "Saved".
   - **Design tasks (D20)** show a **Design** section here, before Depends on (on mobile, in the Details tab):
     - A version menu (`v3 · Approved`, `v2 · Superseded`, …), newest first, a **Desktop / Mobile** viewport toggle and a link that opens the prototype full size (`/designs/:versionId`).
     - The prototype in `DesignPreview`'s sandboxed iframe, rendered at 1280×800 or 390×844 and scaled down to fit the column, so a desktop layout stays a desktop layout.
     - The version's state badge, branch and commit. A superseded version says so; one sent back shows the human's feedback.
     - When the task is in Human review and the selected version is the submitted one: **Request changes**, which opens the prompt composer (images can be attached) and sends the feedback to the developer (Human review → In progress, kept on the version), and **Approve vN**, with an optional note for the PM, which approves that version and supersedes the earlier ones.
     - Approving a version opens a Plan session titled `Build: <design title>` in the task's project, with the human's first message naming the design task and version (and the note) and asking the PM to plan the build. Its PM turn queues like any other (D9, D13), so approving needs the runner online (503 `runner_offline` otherwise). One session per version: approving the same version again opens none. An approved version shows **Open Plan session**, linking to `/plan/:sessionId`.
     - The version's screenshots as thumbnails that open full size, then its `design.md`.
3. **Depends on:** a list of linked tasks (ref, title, status badge), or "Nothing", with an **Add dependency** ghost button.
4. **Description:** rich text (`UEditor`, TipTap). Images can be pasted, dropped or added from the toolbar's Insert image button: each uploads as an attachment and is stored in the document as an image node with `src: attachment:<id>`, shown from `/api/attachments/<id>/file`. An image alone isn't a description for the Definition of Ready.
   - It's read-only until you press **Edit**.
   - Editing shows a toolbar: bold, italic, inline code | heading, bulleted list, numbered list, code block, link.
   - It also shows a `primary` focus ring, **Cancel** and **Save**.
   - Supported content: paragraphs, headings, lists, inline code, code blocks, links, bold and italic.
5. **Acceptance criteria:** a count ("2 of 3 met") and one row per criterion, each with a met or open icon, an inline-editable text and a remove button. There's an **Add criterion** button and the note "The reviewer marks criteria met from evidence." Humans can't tick criteria.
6. **Activity:**
   - **Events:** a dot, the actor, the text and the time.
   - **Comments:** an avatar and a bubble.
   - **Composer** (shared pattern), with no recipient picker. The destination is implicit:
     - If an agent holds the task (In progress, Blocked, Agent review or Human review), messages go to the developer: "Atlas gets this on its next step."
     - Otherwise they're saved as notes: "No agent is working on this task, so this is saved as a note."

## Rules

- Editing the description or criteria while an agent is working sends the change to that agent (PRD §7.3). Show "Changes and comments are sent to {developer}."
- Every edit is recorded with the actor and time (PRD §7.3).
- The status menu only lists transitions allowed for a human. The server enforces this anyway (D10).
- Switching to a different task resets edits and the draft. The flyout width is kept.

## Data

- **Task:** ref, project, title, status, priority, type (Task / Bug / Spike / Design, D19, D20), epic, developer, reviewer, human review flag, branch, PR, review round, description (rich text JSON), criteria (text, met), dependencies, activity.
- **Writes:** a `PATCH` per field, saved as you go. Description saves on Save. Comments are a `POST`.

## Responsive

- **Below 1100px:** the docked flyout drops under the page content at full width.
- **Page mode:** the rail moves under the content below about 900px.

## Accessibility

- The flyout panel is `role="complementary"` and labelled "Task COR-29"; page mode is `main`.
- The resize divider is a focusable `separator` that moves with the arrow keys.
- Select menus are listboxes and close on Escape or a click outside.
- The rich-text toolbar is `role="toolbar"` and every button has a label.

## Open questions

- Should "Open full page" replace the current page or open a new tab?
- Should humans be able to reorder acceptance criteria?

## Merged tasks

Merged is final (D10). The task reads as it shipped: title, properties, dependencies, description and criteria are shown but not editable (a lock note says "Merged, so read-only. You can still comment."), and the server rejects edits with `409 task_merged`. Comments still work.
