# COR-154 v4 — Board task card, Option A

v3 feedback: keep Option A, drop the others, remove the assignee's name, show the task type with icons (nothing for task, bug icon for bug, paint icon for design), try a blocked icon with the blocking tasks in a popover, make sure the long blocked and failed message doesn't carry over, and offset the glow start so cards aren't in sync.

Open `index.html` to land on the Board. Route: `index.html#/projects/corral/board`. Add `?blocked=ban`, `hourglass`, `lock` or `link` to pick a blocked icon, or use the buttons above the Board. Desktop columns are 272px and scroll sideways; a phone shows one column at a time (`&column=ready`, `blocked`, and so on).

## card-option-a — Option A / Stacked

Options B to E are removed, and `card-option-b` to `card-option-e` no longer exist. Mobile uses the same card at the column's full width, so there is no separate mobile screen id.

Layout, top to bottom:

1. **Title**, wrapping as far as it needs.
2. **Epic**, one line, truncated. Omitted when there is none.
3. **Footer**: the priority word on the left, then on the right the blocked icon, the type icon and the assignee's avatar.

Rationale and trade-offs: the title gets the full card width, because every icon sits in the footer. The left edge stays straight, since a plain task has no icon to leave a gap. All the small signals are in one place, so they scan down a column. The cost is that the type sits at the bottom of the card, and a card with no name relies on recognising the initial or picture; the full name shows on hover only, so phones don't get it.

### What each part does

**Assignee.** Avatar only, never a name. Agent review shows `task.reviewer`; every other status shows `task.developer`. If that field is null, the card shows a dashed circle (hover: Unassigned). It never falls back to the other role.

**Type icon.** Task: nothing. Bug: `i-lucide-bug`. Design: `i-lucide-paintbrush`. Spike: `i-lucide-flask-conical`, the icon spikes already use elsewhere in the app. You didn't list spike; I gave it an icon so it doesn't read as a plain task. All are muted, because colour on the card belongs to priority.

**Blocked icon.** Shown when a Ready task has dependencies that aren't merged, which is the same rule as today's "Waiting on" note. A merged dependency doesn't count. The icon is amber, and clicking it opens a popover headed "Waiting on" that lists each blocking task's title, ref and status. Clicking a row opens that task's flyout. Clicking the icon doesn't open the card's flyout. Escape or clicking outside closes the popover.

The four blocked icons to compare:

| Button | Icon | Read |
| --- | --- | --- |
| Ban (default, my pick) | `i-lucide-ban` | Clearest "can't start", and it stays legible at 16px |
| Hourglass | `i-lucide-hourglass` | Says "waiting", but sounds passive and could read as a slow task |
| Lock | `i-lucide-lock` | Clear, but suggests permissions rather than order of work |
| Link | `i-lucide-link-2` | Says "dependency" but not "stopped", so it's the easiest to miss |

**Removed from the card.** The whole note line, in every status: blocked and failed reasons, review round, "Waiting for you", "Merges when checks pass". The waiting note is replaced by the blocked icon. Also gone: ref, type badge, design-changed badge and PR link. All of it stays in the flyout.

**Glow.** `BorderGlow` now picks a random point in the lap when each card mounts, using a negative `animation-delay`. Cards working at the same time sweep out of step, and the offsets change on each load. This is in the real component, so the project overview's glows get it too. With reduced motion the sweep is off, and every glow rests at the same angle, as it does today.

**Selected and working.** Selected keeps the primary border and ring. Working keeps the glow, and the avatar's green dot shows when the displayed assignee holds the lease.

### States and fixtures

| State | Fixture |
| --- | --- |
| Working, glow, glows out of step | COR-3, 26, 27 In progress; COR-4, 28 Agent review |
| Agent review shows reviewer | COR-4, COR-28: Rita. Developer not shown |
| Agent review, no reviewer | COR-25: dashed circle, though Dana is its developer |
| Selected | COR-24, In progress (preview state; clicking any card moves it) |
| Blocked, one blocker | COR-6, Ready: waiting on COR-5 |
| Blocked, three blockers, long title, no epic, urgent, bug | COR-21, Ready: waiting on COR-3, 4, 8 |
| Merged dependency, no blocked icon | COR-23, Ready: depends on merged COR-1 |
| Design type | COR-23, COR-26, COR-4 |
| Bug type | COR-21, COR-24, COR-9 |
| Spike type | COR-22, COR-25 |
| Plain task, no type icon | COR-3, COR-27 |
| Priorities | Urgent COR-21; High COR-3; Medium COR-6; Low COR-22 |
| Long epic truncated | COR-22, COR-26 |
| Long reason not shown | COR-8 blocked, COR-9 failed: both have a `statusReason`, and it appears only in the flyout |
| PR link not on the card | COR-3 PR #66, in the flyout |

### Interactions

- Click anywhere on a card to open the real TaskFlyout; click again to close. On a phone the flyout fills the Board area here, while today's phone Board goes to the task page.
- The title is the card's keyboard button: Tab to it, then Enter or Space. A focus ring shows round the whole card.
- The blocked icon is its own button, so Tab reaches it after the title. The card is a `div` rather than a `button` so this is valid HTML: a button can't hold another button.
- PR links are reached from the flyout's properties, and open in a new tab.

### Components

Real app and mobile shells, UDashboardPanel, UButton, UBadge (column counts only), UPopover, UIcon, AgentAvatar, BorderGlow, TaskFlyout, TaskDetail.

New in the prototype: `PrototypeTaskCard` (the card), `PrototypeCardAssignee` (avatar or dashed circle), `PrototypeCardBlockers` (blocked icon and popover), `PrototypeCardBoard` (the Board page and the icon switcher). `BorderGlow` is changed in place. Otherwise production rendering is untouched: the replacement Board is gated by `import.meta.prototype`. `PrototypePriorityBars` is deleted.

## Mock data and data availability

Data uses the typed `Task`, `Agent` and `Epic` fixtures through the in-memory mock API. v4 adds COR-26, 27 and 28 as working tasks, gives COR-21 three dependencies and COR-23 a merged one.

**No new data is needed.** `title`, `epicId`, `priority`, `type`, `developer`, `reviewer`, `lease` and `dependsOn` are all on the Task contract, and the popover reads the blockers from the project's task list. The build would need a blocker from another project to be in that list; the prototype doesn't cover that case. The bundle calls no backend.

## Open questions

- **Which blocked icon?** I recommend Ban unless you prefer another once you've compared them.
- **Spike icon**: keep the flask, or show nothing like a plain task?
- **Blocked vs failed**: with the message gone, those two cards look the same in the Blocked & failed column, and nothing says why until you open one. The column's status filter still tells them apart. The word "blocked" also now means two things: the icon on a waiting Ready task and the status in that column. The popover says "Waiting on" to keep them apart, and tasks in the Blocked & failed column don't get the icon.
- **Phone tap**: keep the full-width pane shown here, or today's task page?

## Acceptance criteria that changed

These follow your comments, so the original wording no longer applies:

- "Five options, A to E" is now one, Option A, on a full Board.
- The design-changed badge, status notes and on-card PR link are gone, so "click the PR link" is met through the flyout's link.
- The warning note, error note and `waiting on` note no longer appear as text. The fixtures still have them, and the waiting state is now the icon.

## Validation

The bundle was served from `/prototype-dist/` and driven with agent-browser at 1280px and at 390px with the phone layout forced. `browser-verification.txt` records the results: all columns are 272px; no card or list overflows at either width; no card contains a link, an agent's name or note text, including the blocked and failed cards; clicking a card opens the flyout; the blocked icon opens the popover without opening the flyout; a popover row opens that task; Enter on the title opens the flyout; the flyout has `/pull/66` with `target=_blank`; and the glow delays differ between cards and between loads.

Screenshots: `card-option-a-desktop` (working, selected, blocked, types), `-desktop-later-columns` (reasons not shown), `-desktop-blocked-popover`, `-desktop-flyout`, `-desktop-flyout-from-popover`, `-blocked-icon-hourglass`, `-lock` and `-link`, `-mobile`, `-mobile-ready`, `-mobile-blocked-popover`, `-mobile-blocked-failed`, `-mobile-flyout`.
