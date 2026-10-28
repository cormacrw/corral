# Task flyout and task page

**Canvas frames:** `Task flyout · docked, stacked`, `Task page · split`
**Component:** one `TaskDetail` component with two modes.

| Mode | Where | Layout |
|---|---|---|
| `flyout` | Docked on the right of Inbox, Plan, Board, Backlog and Agent pages | Stacked, one column, resizable 360–960px (default 420px) |
| `page` | `/tasks/:ref`, e.g. `/tasks/COR-29` | Split: content on the left, a 260px properties rail on the right, centred up to 1200px |

The flyout opens with `?task=COR-29` on the current page's URL, so it survives reloads and links can be shared. Pages decide what opens it (a row click, a card click, a chip link). Clicking the same row again closes it.

## Purpose

Read and edit any task from wherever you are, without losing your place. It's the most reused component in the app, so it has to be consistent everywhere.

## Structure

### Header (56px, bottom border)

- **Flyout:** the task ref (`text-muted`) on the left, then a "✓ Saved" note for 1.8s after any edit. On the right: copy link, open full page, close.
- **Page:** a breadcrumb (`Board › COR-29`) with no close or open-full-page buttons.
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
3. **Depends on:** a list of linked tasks (ref, title, status badge), or "Nothing", with an **Add dependency** ghost button.
4. **Description:** rich text (`UEditor`, TipTap).
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

- **Task:** ref, project, title, status, priority, epic, developer, reviewer, human review flag, branch, PR, review round, description (rich text JSON), criteria (text, met), dependencies, activity.
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
