# COR-154 v2 — Five directions for the Board task card

v1 was rejected: "the card should have the developer always shown unless its in agent review, then show the reviewer. No tags they look shit, we need title, epic, priority, assignee thats it." v2 is rebuilt around that. **Every option shows exactly four things: title, epic, priority, assignee.** The options differ only in how those four are arranged.

Open `index.html` to land on the Board. The Option A–E buttons change the whole Board. Direct routes: `index.html#/projects/corral/board?option=a` (replace `a` with `b`–`e`). Desktop columns are 272px and scroll sideways; a phone shows one column at a time.

## Rules shared by all five

**Assignee.** Agent review shows `task.reviewer`. Every other status shows `task.developer`. If that field is null, the card shows "Unassigned" with a dashed circle. It never falls back to the other role, so a task in Agent review with no reviewer yet reads Unassigned even if it has a developer.

**Removed from the card.** Ref, type badge, design-changed badge, PR link and status note (waiting on, review warnings, blocked and failed reasons) are all gone. These fixtures still exist, and the information is in the task flyout. PRs are reached from the flyout's properties.

**No tags.** Epic and priority are plain text or a small glyph, never a pill or badge.

**Kept, because they are states and not content.** `BorderGlow` and the avatar's working dot when the shown assignee holds the lease; primary border and ring when selected.

## Shared screens, states and interactions

Each option uses **the same card on mobile**, at the column's full width, so there are no separate mobile screen ids. Phones default to In progress, which shows the working and selected cards together.

| State | Fixture |
| --- | --- |
| Working developer, glow, high priority, epic | COR-3 "Static prototype build", In progress: Dana. Has a reviewer on file (Rita) that is not shown |
| Working reviewer, glow | COR-4 "Design review screen", Agent review: Rita. Developer on file (Victor) is not shown |
| Agent review with no reviewer | COR-25 "Check narrow column rendering": Unassigned, though Dana is its developer |
| Selected, urgent, no epic | COR-24 "Preserve selection after reconnecting", In progress: Victor |
| Unclaimed, urgent, no epic, long title (3+ lines) | COR-21, Ready: Unassigned |
| Low priority, long epic name truncated to one line | COR-22, Ready: Unassigned |
| Medium priority, epic | COR-6, Ready: Victor |
| High priority, epic | COR-23, Ready: Dana |
| Developer shown after review, Human review | COR-5: Victor |
| Developer shown when blocked or failed | COR-8, COR-9: Victor, Dana |

Task types, the design-changed flag, PR links and notes stay on these fixtures (COR-21 bug, COR-22 spike, COR-23 design with design-changed, COR-3 PR #66, COR-21 waiting, COR-5 warning, COR-8/9 error), and the card deliberately renders none of them. Cards look the same whatever their type.

COR-24 starts selected, as a staging state to show the selected look without opening a pane. Click any card to open the real TaskFlyout; click again to close. The whole card is one button, with a focus ring, and Enter or Space opens it. Its accessible name still includes the ref. On phones the flyout fills the Board area; today's mobile Board goes to the task page instead.

Components: real app shell and mobile shell, UDashboardPanel, UButton, UBadge (column counts only), UIcon, UAvatar through AgentAvatar, BorderGlow, TaskFlyout, TaskDetail. New in the prototype: `PrototypeTaskCard` (the five layouts), `PrototypeCardAssignee` (avatar and name, or Unassigned), `PrototypePriorityBars` (one to four rising bars) and `PrototypeCardBoard` (the comparison page). Production rendering is unchanged: the replacement is gated by `import.meta.prototype`.

## card-option-a — Option A / Stacked

Route: `#/projects/corral/board?option=a`. Mobile: same card.

States: all shared states. Title, then epic on its own line (omitted when there is none), then a footer with the priority word left and the assignee right.

Components: PrototypeTaskCard, PrototypeCardAssignee, AgentAvatar, BorderGlow.

Rationale and trade-offs: the plainest answer to the feedback. Each field sits on its own line as a word, so nothing needs learning, and urgent and high stand out through colour on the word. It is the tallest of the quiet layouts, at three rows for a one-line title, so long columns take more scrolling.

## card-option-b — Option B / Compact

Route: `#/projects/corral/board?option=b`. Mobile: same card.

States: all shared states. Title, then one line: priority bars, truncated epic, 2xs avatar on the right. Tighter padding.

Components: PrototypeTaskCard, PrototypePriorityBars, PrototypeCardAssignee in avatar-only mode, AgentAvatar, BorderGlow.

Rationale and trade-offs: fits the most tasks in a column, and the bars let priority be scanned down the column. The assignee's name is not written out: you read an initial or picture, with the name on hover only, which is weakest against "developer always shown". Bars also need learning, and Low and Medium look similar at a glance.

## card-option-c — Option C / Priority edge

Route: `#/projects/corral/board?option=c`. Mobile: same card.

States: all shared states. A 4px left edge carries priority: Urgent red, High amber, Medium grey, Low pale. Below the title, the footer has the epic left and the assignee right, with the assignee kept whole when the epic is long.

Components: PrototypeTaskCard, PrototypeCardAssignee, AgentAvatar, BorderGlow.

Rationale and trade-offs: the cleanest card body, with no priority text at all, and urgent work jumps out of a column. Priority here relies on colour alone for sighted users (screen readers get the word), and Medium and Low are hard to tell apart. Any status-coloured edge can't be added later without a clash.

## card-option-d — Option D / Assignee first

Route: `#/projects/corral/board?option=d`. Mobile: same card.

States: all shared states. The header row has an sm avatar with the name in bold, and the priority word opposite. Title follows, then the epic. Unclaimed tasks show the dashed circle and Unassigned in the header.

Components: PrototypeTaskCard, PrototypeCardAssignee, AgentAvatar, BorderGlow.

Rationale and trade-offs: makes the rule you asked for the most visible thing on the card, so a glance down a column tells you who has what, and In progress and Agent review read as different people. The title is no longer the first thing you read, and every Unassigned card in Ready spends its top row saying so.

## card-option-e — Option E / Epic header

Route: `#/projects/corral/board?option=e`. Mobile: same card.

States: all shared states. The epic is a one-line header with a divider under it, dropped entirely when there is no epic. The title is 16px. The footer has bars with the priority word on the left and the assignee on the right.

Components: PrototypeTaskCard, PrototypePriorityBars, PrototypeCardAssignee, AgentAvatar, BorderGlow.

Rationale and trade-offs: reads best when a column mixes several epics, and the larger title gives the most comfortable reading. It is the tallest option, cards with and without an epic have visibly different shapes, and long titles take more lines at 16px.

## Mock data and data availability

Data uses the typed `Task`, `Agent` and `Epic` fixtures through the existing in-memory mock API. v2 adds `developer` and `reviewer` to the COR tasks, and the epic `e-board` with a long name. **No option needs new data**: `developer`, `reviewer`, `lease`, `priority`, `epicId` and `title` are all on the Task contract already. The bundle calls no backend.

## Decisions for review

- Choose one of A–E. My recommendation is **D** if who has the task matters most, as your comment suggests, or **A** if the title should still lead.
- Acceptance criteria vs. your comment: the task asks for PR links, type badges, the design-changed badge and notes on the card. Your comment says title, epic, priority and assignee only, so I followed your comment. The PR link now lives only in the flyout, so the "click the PR link" criterion can't be met on the card.
- Losing the note means a Ready task no longer says it is waiting on another task, and a blocked task no longer gives its reason on the card. The column still shows Blocked & failed.
- Whether an unclaimed task should say Unassigned or leave the spot empty. I chose Unassigned, so the assignee position is always filled.
- Whether phone cards keep today's task-page navigation or use the full-width pane shown here.

## Validation

The bundle was served from `/prototype-dist/` and driven with agent-browser at 1280px and 390px. `browser-verification.txt` records it: all desktop columns are 272px; no card or card list overflows horizontally in any option; no links or badges exist inside any card; clicking a card in each option sets `task=COR-3` and opens the flyout at both widths; and the flyout has the `/pull/66` link with `target=_blank`.

Screenshots per screen id: `-desktop.png` and `-mobile.png` (working glow and selected), `-desktop-later-columns.png` (Human review onward), `-mobile-ready.png` (long title, Unassigned, long epic; 390px wide, taller viewport), `-flyout.png` and `-mobile-flyout.png`.
