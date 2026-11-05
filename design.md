# COR-522 · Mobile Home matches desktop Home

**Decision:** a phone renders the same `HomeOverview` as desktop, in a `mobile` mode. `HomeDashboard` and its mobile-only pieces (`HomeScope`, `HomeCounts`, `HomeUsage`, `HomeStages`, `HomeAgents`, `HomeParents`, `useHomeDashboard`) are retired in the build. The two layouts share one data source (`useHomeOverview`), the same sections in the same order, and the same components. The desktop layout does not change: every change is behind `mobile` (see the desktop screenshots).

`pages/home/index.vue` becomes `<HomeOverview :mobile="device.isMobile.value" />`.

## Screens

| id | Route in the bundle | What it shows |
|---|---|---|
| `home-mobile` | `#/home` (Settings → Layout: Mobile, or a phone) | Mobile Home with live data |
| `home-mobile-loading` | `#/home?state=loading` | Task lists, runs and cycle time still loading |
| `home-mobile-empty` | `#/home?state=empty` | A quiet workspace: no runs, nothing merged or in flight, no agent working, no parents |
| `home-mobile-error` | `#/home?state=error` | Runs failed to load (after the query's own retries), with Retry |
| `home-desktop` (+ `-loading`, `-empty`, `-error`) | same routes at 1280 px, Layout: Desktop | Unchanged desktop Home, for comparison |

`?state=` is a prototype-only switch in `prototype/mock-api.ts` (`scenarioCall`); it is not part of the build. Reload after changing it.

## Layout: `home-mobile` (390 × 844, one column)

Content sits in the mobile shell between the safe area and the tab bar, `p-4`, `gap-4`, max width 640 px. No title row (mobile.md: tab roots have none). The page never scrolls sideways; measured `scrollWidth` = 390 in every state.

Order, top to bottom, matching desktop:

0. **Runner line** — `● Runner online · All projects` (or "n of m runners online"). See "Mobile-only elements".
1. **Needs you** — `StatTile` (same props as desktop) inside the existing `NuxtLink to="/inbox"`, spanning **both columns** so the one actionable tile is the biggest, top-most target (358 × 108). Tap opens the Inbox, as on desktop. Pressed state `active:bg-muted`.
2. **In flight** and 3. **Merged this week** — `StatTile`, side by side (2-column grid, `grid-cols-2` which is already desktop's base). Merged keeps its delta and 14-day `TrendSparkline`; the hint wraps under the delta.
4. **Median cycle time** and 5. **Runs today** — `StatTile`, side by side. Desktop's `col-span-2` on Runs today is dropped on mobile because Needs you now takes the full row (5 tiles = 1 + 2 + 2). Runs today carries today's tokens and failed count in its hint (it absorbs the old "today's usage").
   - Tiles **wrap** rather than scroll sideways: all five numbers are visible in the first screen without a gesture, and nothing hides off-screen.
6. **Throughput** — `DashboardCard` + `HomeThroughput`, a compact chart: `height` 150 (was 220) and a new `ticks` prop at 4 x-axis labels (6 on desktop) so dates don't collide at 340 px. Same stacking, project colours, legend and tooltip (touch shows the crosshair tooltip on tap). The chart is not a tap target.
7. **Parents** — `DashboardCard` + `HomeRecentEpics` with `mobile`: the 4 most recent (desktop 6) to keep the page short. Each row becomes one tap target (≥ 104 px tall here, min 44) via an overlay `NuxtLink` to `/epics/<id>`, the same pattern as the Agents rows; the inner title and PR links are under it, so taps never land on a 16 px link.
8. **Open work by project** — `DashboardCard` + `HomeOpenWork` with `mobile`: same stage-split bar and legend, each row `min-h-11` (44 px) and opens the project Board.
9. **Agents · Running now** — `DashboardCard` + `HomeLiveAgents` with `mobile`: each agent row is one target (`min-h-11`) to the agent page. The task ref shows as plain mono text instead of a `TaskLink`, because a 16 px inline link inside a row is not a safe touch target; the agent page's Current run has Open task. **All agents** grows from `xs` to `sm` with `min-h-11`.

All tap targets measured in the prototype are ≥ 44 px (smallest: All agents 99 × 44, Open work rows 340 × 44, Retry 65 × 44).

## Section → reused component / token

| Mobile section | Reuses | New? |
|---|---|---|
| Runner line | markup + `bg-success` / `bg-destructive` dot from `HomeScope`, data from `useShell().runner` | Small inline block in `HomeOverview` (no component); `HomeScope` is retired |
| Needs you, In flight, Merged this week, Median cycle time, Runs today | `StatTile`, `TrendSparkline`, `useHomeOverview().kpis` | No |
| Throughput | `DashboardCard`, `HomeThroughput` | New optional prop `ticks` (default 6) |
| Parents | `DashboardCard`, `HomeRecentEpics`, `EpicProgressRow` | New optional prop `mobile` (whole-row link, tighter gap) |
| Open work by project | `DashboardCard`, `HomeOpenWork`, `ChartLegend`, `--chart-1…5` | New optional prop `mobile` (44 px rows) |
| Agents running now | `DashboardCard`, `HomeLiveAgents`, `AgentAvatar`, `AppBadge`, `AppButton` | New optional prop `mobile` (44 px rows, ref as text) |
| Loading | `UiSkeleton` (as `HomeCounts` used) | No |
| Error | `AppLoadError` (`AppAlert`) | No; buttons get `min-h-11` on mobile via a class |
| Empty | each component's own empty copy | No |

## Mobile-only elements

| Element | Decision | Why |
|---|---|---|
| **Project scope picker** (All projects / one project) | **Drop.** The line keeps the static words "All projects". | Desktop Home is workspace-wide and has no filter; per-project views already exist (Projects tab → Project overview, Board). Throughput and Open work show the per-project split in project colours, which is what the picker was used for. One fewer control above the fold. |
| **Runner status** | **Keep**, as the first line. | mobile.md: runner status shows only on Home on phones; desktop has it in the sidebar footer, which phones don't have. It's one line, read-only, no target. |
| **In progress by stage** (stage bar + attention link) | **Merge** into Open work by project (same stages, same order, split per project) and the In flight / Needs you tiles (In flight = the stage total; "n blocked or failed" is the Needs you hint, and Needs you links to the Inbox like the old attention row). | Same information as desktop; keeping it would duplicate Open work. |
| **Today's usage** (Runs / Usage tiles and the subscription note) | **Merge** into the **Runs today** tile: value = runs today, hint = "{tokens} tokens · {n} failed". Drop the subscription note. | Desktop already shows exactly this in Runs today. The note is covered by Settings → Runners ("Corral never reads credentials"). |
| Old tiles **To do / In progress / Completed today** | Replaced by the desktop tiles. | To do (Ready) is in Open work; In progress → In flight; Completed today → Merged this week + Throughput (today's bar). |
| Old **Agents** cards (bordered cards with ring) | Replaced by `HomeLiveAgents` rows. | Same content (status, run, project dot, elapsed) in the desktop's lighter list; idle agents without a status are no longer listed, as on desktop; **All agents** reaches the full list. |

## States

- **Default** (`home-mobile`): fixture workspace — 15 need you, 11 in flight, 32 merged this week, 12h median, 8 runs.
- **Loading** (`home-mobile-loading`): tiles show `–` (desktop convention) and Runs today shows `–` with no hint; Throughput, Parents and Open work bodies show `UiSkeleton` blocks (150 px chart; 3 × 40 px rows; 2 × 24 px bars) instead of "Nothing merged" / zeros; Agents shows 2 skeleton rows until runs arrive. Needs you shows as soon as the shell's Inbox count is in. Card headers stay, so nothing jumps when data lands.
- **Empty** (`home-mobile-empty`): In flight 0 ("0 of 7 agents working"), Merged 0 with flat sparkline, cycle time `–` "nothing merged in 7 days", Runs today 0 "0 tokens"; Throughput "Nothing merged in the last 30 days."; Parents "No parent tasks yet."; Open work shows only Ready bars; Agents "No agent is working right now." and All agents. (Needs you keeps the shell's live Inbox count, which the mock doesn't zero; at 0 it reads "0 · in the Inbox".)
- **Error** (`home-mobile-error`): `AppLoadError` "Couldn't load recent runs" with the server message and a 44 px **Retry**, above Needs you. Runs today shows `–` "couldn't load runs"; Agents falls back to its empty copy. Task-based sections (tiles, Throughput, Parents, Open work) still render, because they come from the task lists, not runs.

## Interactions

- Tap **Needs you** → `/inbox` (verified in the prototype: URL becomes `#/inbox`). Tab bar's Inbox stays the other path.
- Tap a **Parent** row → `/epics/<id>`; an **Open work** row → `/projects/<slug>/board`; an **Agent** row → `/agents/<name>`; **All agents** → `/agents`.
- Tap the Throughput chart → crosshair tooltip for that day (existing unovis behaviour).
- **Retry** → refetches runs (`useRunHistory().retry`).
- Everything stays live through the shell's event stream, as today.

## Mock data

No new shapes. Existing fixtures (`projects`, `tasks`, `epics`, `agents`, `runs`, `runner`, `inbox`, `/metrics/flow`). The prototype-only `scenarioCall` in `mock-api.ts` derives the states:

- `loading`: `GET /projects/:slug/tasks|epics`, `/runs`, `/metrics/flow` never resolve.
- `empty`: `/runs` and epics `[]`; tasks filtered to `backlog` and `ready`; agents with `activeRuns: 0`, not paused; flow `mergedTaskCount: 0`.
- `error`: `/runs` → 500 (the client retries, then the alert shows after ~8 s).

## Build notes

- `useHomeOverview` also returns `runsLoading` (`useRunHistory().loading`).
- Retire `HomeDashboard`, `HomeScope`, `HomeCounts`, `HomeUsage`, `HomeStages`, `HomeAgents`, `HomeParents`, `useHomeDashboard` and their tests; update tests that look for `home-dashboard` / `home-project` test ids. New test ids: `home-runner`, `home-needs-you`, `home-runs-error`.
- Update `docs/design/mobile.md#home` and `docs/design/home.md` (the "Phones show the single-column dashboard" line) to point at this layout.

## Open questions

1. Parents shows 4 on mobile vs 6 on desktop. Fine, or keep 6 for parity? (Recommendation: 4; the list is long on a phone and the Projects tab has the rest.)
2. Dropping the project picker removes a one-project view of today's numbers from the phone. If that's used, a follow-up could add a project filter to both layouts at once rather than only mobile.
