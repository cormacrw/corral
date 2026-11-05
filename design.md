# COR-523 · Agent page as a dashboard

Prototype: `pnpm --filter web prototype`, routes `#/agents/<name>`. Built from the real components: `DashboardCard`, `StatTile` (+`TrendSparkline`), `AgentsRunTimeline`, `AgentsTokenChart`, `ChartLegend`, `AppLoadError`, `UiSkeleton`, `AgentAvatar`, `AppBadge`, `AgentRunSummary`. One new chart, `AgentOutcomeChart`, copies `HomeThroughput`'s stacked-bar setup and uses the timeline's `RUN_TONE` colours. No new chart style.

## Screens

| id | Route | What |
|---|---|---|
| `agent-desktop` | `/agents/:name` (no run) | Header, tiles, charts, Recent runs card |
| `agent-run-desktop` | `/agents/:name/:runId` | The current two-pane run view, plus an **← Activity** link at the top of the runs list that goes back to `agent-desktop` |
| `agent-mobile` | `/agents/:name` | Header, tiles that scroll sideways, Current run, **Activity** (3 cards stacked), Previous runs |
| `agent-run-mobile` | `/agents/:name/:runId` | Same transcript screen as today |

### agent-desktop layout
1. **Header**, as today: avatar with working dot, name, a status badge (Paused or Waiting on usage limit), "{Role} · {runtime} · N runs today", **Resume now** (only while waiting on a usage limit) and **Agent settings**.
2. **Stat tiles**: `StatTile`s in the Agents dashboard's grid (2 / 3 / 5 columns), each with an icon. The Avg tile also has a sparkline of the median run length per day. The facts line goes under the tiles.
3. Grid `lg:grid-cols-3`:
   - left, 2 columns wide: **Runs** (`AgentsRunTimeline`, last 7 days, one lane per day, x is the hour of day 00:00–24:00), then **Outcomes** (finished runs per day for 14 days, stacked Finished / Changes requested / Failed or stuck / Interrupted or rate limited) and **Tokens** (`AgentsTokenChart` with `only=<role>`, 14 days, in the role's dashboard colour, no legend).
   - right: **Recent runs** card, up to 42rem tall, scrolling inside the card. A live run is pinned first with a primary edge and a **Live** badge. Each row has an outcome dot in the timeline colour, the ref, when it ran (or the elapsed time while live), the title, "project · Run #n · duration" and any error (2 lines). **Selecting a row opens `/agents/:name/:runId`** (`agent-run-desktop`).

On desktop, `/agents/:name` no longer selects the latest run on its own. The dashboard is the landing view, and a live run is one click away at the top of Recent runs.

## States (each at desktop and mobile)

| State | Prototype | What shows |
|---|---|---|
| Live | `#/agents/victor` | Working dot, Live row pinned first (on mobile, the Current run card), a live bar in the Today lane (blue) |
| Paused | `#/agents/pax` | **Paused** badge, history charts, no current run ("Pax is idle.") |
| Waiting on usage limit | `#/agents/uma` | Badge, "until hh:mm", **Resume now** |
| No runs | `#/agents/nova` | Tiles show real zeros and "—" for Avg run. Charts show their empty text ("No runs in the last 7 days.", "No finished runs…", "No tokens used…"). Recent runs: "No runs yet. Runs show here once Nova picks up its first task." |
| Loading | `#/agents/victor?mock=loading` | Skeleton tiles, a skeleton in each chart card, skeleton rows. The header leaves out "N runs today" |
| Load error | `#/agents/victor?mock=error` | Tiles show **—** with "Couldn't load runs". A "Couldn't load {name}'s activity" alert with Retry. Chart cards read "Unavailable" (on mobile the cards are replaced by the alert). Recent runs shows `AppLoadError` with Retry. The header leaves out the run count. **No zeros are made up.** |

`?mock=loading|error` is prototype-only (in `mock-api.ts`) and makes `GET /runs` hang or return a 500.

## Role-specific stat tiles (unchanged from today's `useAgentRuns`)

| Role | Tiles |
|---|---|
| Developer | Runs this week · PRs opened (incl. revisions and commits) · Stuck · Avg run · Usage today |
| Reviewer | Reviews this week · Approved · Changes requested · Avg review · Usage today |
| Designer | Runs this week · Design versions submitted · Designs approved · Avg run · Usage today (version counts are "—" if the design data fails) |
| PM | Turns this week · Avg turn · Usage today |

Avg run / review / turn gets the duration sparkline when there are 2 or more days with finished runs. Screens: `agent-*-desktop/mobile` for victor (developer), rita (reviewer), iris (designer), pam (PM).

## Data each chart uses

Chart source: `GET /api/runs?since=<local midnight 13 days ago>` (`useRunHistory`, the same cache as Home and Agents, up to 2000 runs), filtered client-side by `agentId`. The tiles and Recent runs keep `GET /api/runs?agentId=` (the latest 50).

| Chart | Run fields | Returned today? |
|---|---|---|
| Runs timeline | `agentId`, `startedAt`, `endedAt`, `state`, `outcome`, `taskRef`/`epicId`/`taskTitle` (tooltip), `agentName` | Yes |
| Outcomes per day | `agentId`, `queuedAt`, `state`, `outcome` | Yes |
| Tokens per day | `agentId`, `queuedAt`, `role`, `inputTokens`, `cacheWriteTokens`, `outputTokens` | Yes |
| Avg run sparkline | `agentId`, `queuedAt`, `startedAt`, `endedAt` | Yes |
| Recent runs | `id`, `number`, `taskRef`, `taskTitle`, `epicTitle`, `projectId`, `queuedAt`, `startedAt`, `endedAt`, `state`, `outcome`, `error` | Yes |

**No new server field is needed.** One caveat: the history is capped at 2000 runs across all agents. If a busy fleet hits that cap, a quiet agent's oldest days could be cut off. A per-agent `since` filter (`?agentId=&since=`) would remove the cap risk; the API accepts both today, so this only changes the query.

## Mock data shape (`apps/web/app/prototype/fixtures.ts`)
- `Run[]` adds 13 days of generated runs for each agent except Nova (seeded, deterministic, ≥1 day old so they never become a task's latest run). Each agent has its own mix of outcomes.
- New agent `a-new` "Nova" (developer, no runs).
- `mock-api` `GET /runs`: when filtered by `agentId` (and no `since`), it sorts newest first and returns 50, as the server does.

## Interactions
- Recent runs row: click → `/agents/:name/:runId`. Desktop then shows the runs list and transcript; mobile shows the transcript (a PM turn with a Plan session opens Plan, as today).
- **← Activity** (desktop run view) → back to the dashboard.
- Timeline bar hover: agent, ref, outcome, duration. Outcomes and Tokens charts: crosshair tooltip per day.
- Retry on an error refetches the runs and the history.

## Build notes
- `runTone`: a PM turn that completed with no outcome counts as Finished, not Interrupted (today it shows grey on the Agents timeline too).
- `MobileAgent.test.ts` and `agent-run-state.test.ts` need updating: the dashboard replaces auto-selecting a run on desktop, and `useAgentActivity` needs stubbing.

## Open questions
1. Should desktop `/agents/:name` still jump straight to a live run's transcript when one is running? The proposal is no: show the dashboard with the live run pinned.
2. The tile definitions differ from `docs/design/agent.md` (which lists PRs merged / first-pass approval etc.). The prototype keeps the shipped tiles. Should the doc be updated to match?
