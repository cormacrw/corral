# COR-154 — Five directions for the Board task card

Open `index.html` to land on the Board. The labelled Option A–E buttons change the complete Board, retaining column and selection. Direct routes: `index.html#/projects/corral/board?option=a` (replace a with b–e). Desktop columns remain 272px wide and scroll horizontally; phone layout has one column at a time. This is a design comparison, not a proposed change to Board filters. The prototype replaces the Board toolbar with comparison controls.

## Shared screens, states and interactions

Each screen below uses **the same card on mobile**, expanded to the available column width. No separate mobile screen ids are needed. Capture widths are 1280px desktop and 390px phone; screenshots use the existing Mobile layout override, equivalent to a touch-first phone. Phone defaults to In progress to show both the working and selected cards together. All status tabs remain available, including Ready (long title, waiting, design changed), Human review (warning) and Blocked & failed (error).

All five screens cover these states from `app/prototype/fixtures.ts`:

| State | Fixture |
| --- | --- |
| Urgent / bug / no epic / long title / waiting | COR-21, Ready; title intentionally wraps beyond three lines at desktop card width |
| High / active lease / agent / PR | COR-3, In progress; Dana, PR #66, BorderGlow |
| Low / spike / no epic | COR-22, Ready |
| Design type / high / design changed / epic | COR-23, Ready; pinned v1, newer approved v2 |
| Ordinary task / epic / waiting | COR-6, Ready |
| Selected / urgent / bug / no lease | COR-24, In progress; primary border and ring |
| Reviewer working / review round | COR-4, Agent review; Rita, round 1 of 3 |
| Warning note | COR-5, Human review; “Waiting for you” |
| Error note | COR-8 and COR-9, Blocked & failed; reason text |
| Criteria met / empty criteria / dependencies | COR-5 / COR-22 / COR-21, respectively |

COR-24 initially demonstrates the selected appearance without opening a pane, keeping the full Board available for comparison. This is a prototype staging state, not proposed product behaviour. Click any card to open the **real TaskFlyout / TaskDetail** and apply actual selection; click it again to close. PR anchors are siblings of the full-card button, above its hit area, open a new tab and stop propagation; they never open task details. Tab focuses cards and links separately; Enter/Space activates cards. The 8px card-list padding accommodates the existing 8px BorderGlow. Selection, urgency and activity all have textual or structural cues as well as colour. Existing BorderGlow and AgentAvatar respect reduced motion.

On phones the flyout occupies the Board content area with its normal close action. This intentionally follows this task's flyout/PR interaction criterion; today's mobile Board instead navigates to task pages and does not link PRs. The eventual build should explicitly carry this interaction decision forward or retain the existing mobile navigation after human review.

Shared components: real app shell and mobile shell, UDashboardPanel, UButton, UBadge, UIcon, TaskTypeBadge, DesignChangedBadge, AgentAvatar, BorderGlow, TaskFlyout and TaskDetail. New shared `PrototypeTaskCard` composes the five layouts; `PrototypeCardBoard` hosts the comparison. All are styled with Nuxt UI tokens and Tailwind utilities. Production Board rendering is unchanged because the replacement is gated by `import.meta.prototype`.

## card-option-a — Option A / Refined

Route: `#/projects/corral/board?option=a`. Mobile: same card.

States: all shared states above; metadata wraps, design-changed gets its own row, working agent is in the footer, selected ring surrounds the card. Components: all shared components, with UBadge through TaskTypeBadge and DesignChangedBadge.

Rationale and trade-offs: retain the familiar ref → title → note → epic/agent rhythm while giving the title a clear weight and keeping metadata from colliding. The separate design-changed row solves the crowded original meta row. This is the lowest learning cost and a balanced default, but cards with notes and badges remain relatively tall and agent activity is a secondary cue.

## card-option-b — Option B / Dense

Route: `#/projects/corral/board?option=b`. Mobile: same card.

States: all shared states above, at 12px title size with 20px leading and 8px padding. Components: shared components, same badges and footer avatar at xs size.

Rationale and trade-offs: reduce padding and title size so quiet tasks need roughly two content lines plus their metadata; long titles, warnings and design changes expand naturally instead of being truncated. This fits more tasks in long columns while preserving every state. The smaller type is less comfortable for extended reading, and busy cards still grow: this direction chooses truthful information over a strict two-line height.

## card-option-c — Option C / Status first

Route: `#/projects/corral/board?option=c`. Mobile: same card.

States: all shared states above. Working text leads for a leased task; otherwise taskNote leads, falling back to the labelled status. Warning/error text and edge use their semantic colours. Components: shared components with an activity strip, divider and 4px leading edge.

Rationale and trade-offs: put the next meaningful signal above identity and title so waiting, failed and actively worked tasks are easy to find. The strip gives even idle cards a clear state. It repeats column status on quiet cards and increases height; a lease takes precedence over a review note in the strip, while the full details remain available in the flyout. The edge uses primary for non-warning/non-error activity rather than inventing additional status colours.

## card-option-d — Option D / People first

Route: `#/projects/corral/board?option=d`. Mobile: same card.

States: all shared states above. Working agents get a prominent sm avatar, name and role; tasks without a lease explicitly say “Not claimed / Available to the team”. Priority moves to the footer. Components: shared components, larger AgentAvatar, dashed-circle UIcon placeholder.

Rationale and trade-offs: make responsibility and active agent presence the first thing read. This is useful when monitoring several agents and makes claimed versus unclaimed work explicit without suggesting advance assignment. The placeholder consumes space on idle cards and can dominate quiet columns; priority is less immediate than in A–C. Only a current lease creates this agent header, never a historical developer/reviewer assignment.

## card-option-e — Option E / Rich

Route: `#/projects/corral/board?option=e`. Mobile: same card.

States: all shared states above, plus criteria with true/null verdicts, no criteria (0/0), review round zero (“No review yet”), positive review rounds, and dependencies. Components: shared components with a muted criteria panel and segmented criteria-verdict bar.

Rationale and trade-offs: expose review readiness alongside the task. The panel counts acceptanceCriteria with `met === true`, labels its denominator, and shows reviewRounds and dependsOn refs. It is **not estimated implementation progress**: unreviewed criteria remain neutral and 0/0 does not imply completion. This helps review-oriented work but adds substantial height and repeats some note information. It should be chosen only if the additional review context is worth reduced scan density.

## Mock data and data availability

Data uses typed `Task`, `Agent`, `Project` and `Epic` fixtures served by the existing in-memory mock API. New records use `task(project, number, overrides)`; timestamps use `ago()`. Titles, type, priority, design pin, PR URL/number, lease, reviewRounds, acceptanceCriteria `{ id, position, text, met }`, dependsOn and epicId already exist on Task. Agent name/role resolves from the existing live agents list; epic names resolve through the Board's existing epic data. No option needs new contract fields, API endpoints, evidence counts, time estimates or provider credentials. Review cap is the fixture project's existing value, 3. No backend or external service is called by the bundle; PR navigation is only an explicit user action.

## Review decisions

Choose A–E as the preferred direction. A is the continuity choice; B favours scan density; C favours operational status; D favours agent monitoring; E favours review context. Confirm whether phone cards should keep today's task-page navigation or use the full-width detail pane demonstrated here. No other data or implementation decisions block review.

## Validation and review artifacts

The static bundle was served from `/prototype-dist/`, a sub-path, and exercised with agent-browser. Every option was checked at 1280px and 390px: desktop sections measure exactly 272px, card scrollWidth never exceeds clientWidth, and the document stays within its viewport. For A–E, clicking COR-24 opened TaskFlyout, Close cleared the selection query, and PR #66 opened a separate tab while the Board retained no task query. GitHub requests were intercepted and aborted during this check. Each option was also opened in the phone detail pane.

For each screen id, `-desktop.png` and `-mobile.png` show working glow and the staged selected card; `-review-errors.png` shows the warning/error columns; `-mobile-ready.png` shows the phone's waiting, long-title, low-priority spike and design-changed cases. The latter uses a taller 390px-wide viewport to show the complete fixture column. `-flyout.png` and `-mobile-flyout.png` show real task details after a click. `browser-verification.json` records browser-observed dimensions and PR tab URLs. Lint, typecheck, tests and the documented prototype build passed; database integration tests follow the project's existing CI-only Postgres policy. No running Corral dev stack or GitHub writes were used.
