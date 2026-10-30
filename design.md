# COR-191 — Desktop Home directions

**v3.** Option B's sections keep their normal spacing when the epic lists are empty, and the mobile Home capture and its description are corrected.

**v2.** The layouts are unchanged from v1. v2 fixes the singular labels, gives the busy and blocked fixtures separate projects (adding Companion app) and gives each epic its own description.

A global landing page for checking progress and deciding where human attention will help. Three alternatives use the real Corral shell, tokens, fonts and shared components. These are reviewable alternatives, not three modes proposed for the shipped product.

## Screens and routes

| Stable screen id | URL in the static bundle | Direction |
| --- | --- | --- |
| home-desktop-option-a | `index.html#/home?option=a` | Projects first: a row of project cards (four in the fixtures), a compact attention strip, then open and completed epics in parallel columns. |
| home-desktop-option-b | `index.html#/home?option=b` | Epics first: a wide work column and a narrow project rail. Recent completions follow the open epics in the main column. |
| home-desktop-option-c | `index.html#/home?option=c` | Attention first: a full-width decision strip with the epic PR to review; projects sit left of a combined epic activity timeline. |

`index.html#/` redirects to Home, preserving query parameters. An absent or invalid option selects A. The Option A–C buttons replace the query and redraw the same Home component without changing the underlying data. Browser refresh and copied URLs preserve the selection. The production build should retain only the chosen direction, removing the option and preview controls.

## Shared information and behaviour

- Every project appears, including quiet projects. The entire project card links to `/projects/:slug/board`. Project colour, name, in-progress total, all four stage counts, blocked/failed count, items to review (task reviews plus epic PR reviews, so the cards add up to the Needs you figure), Backlog size and merged-today activity are visible. Zeroes are intentional; they distinguish a quiet project from missing data.
- Needs you links to `/inbox`, with the real Inbox count. Human reviews count task reviews and epic PR reviews. Blocked and failed link directly to the task when exactly one qualifies, otherwise to Inbox. These counts overlap with Inbox; they are not an additive total. Plan questions and unread threads remain included in the Inbox count.
- Every open epic shows project, title, merged/total board tasks, an accessible progress meter, in-flight work or a waiting message, blocked/failed and human-review attention, review mode and elapsed time since last update. Titles and attention lines open `/epics/:id`; the real epic detail page opens, rather than a placeholder.
- An epic with all tasks merged into its epic branch remains open while its epic PR awaits the human. The 4/4 Runner updates fixture explicitly demonstrates this D23 distinction. Draft-only and empty epics do not count as open work.
- Recently completed means completion within the trailing 14 days. A and B list completions newest first. C interleaves open activity and completions in descending time; the completed subsequence is still newest first. Each completion includes project, completion date, title and task count, and links to its epic. Completed rows use a check icon rather than a status badge.
- Agents and runner stay in the existing sidebar. Home adds no duplicate agent cards or usage panels. The offline state uses the shell's existing banner and Runners settings link.
- No badges are added to Home. Typography, spacing, progress bars, project dots and plain status text establish hierarchy. Blocked/failed use error text; reviews use warning text. Labels carry meaning independently of colour. Existing shell badges remain unchanged.
- The page scrolls vertically inside the dashboard panel. At 1280px columns tighten; at 1920px the content caps at 1600px to avoid long reading lines. At narrow desktop widths the content becomes one column, keeping controls and text usable.

## States (apply to all three screen ids)

The prototype-only **Preview state** selector preserves `option`. States also work as `&state=…` in the URL.

| Query state | Content and interaction |
| --- | --- |
| default | Four projects, four open epics and four recent completions. |
| empty | Both empty lists: “No open epics” with a caught-up explanation; “Nothing completed recently” with the 14-day explanation. Project and task summaries remain populated to isolate the epic-list states. C retains both messages in its timeline. |
| loading | Skeleton blocks replace all Home data, with an accessible busy state. No fake zero totals are presented as loaded results. Normal loading also waits for each project's task list. |
| no-projects | Home content becomes “A home for your projects” and an Add project link to `/setup?step=repo&add=1`. This is an isolated page-content preview; the sidebar retains fixture projects. In the shipped first-run flow, real zero-project installations still go to onboarding. |
| offline | The shared runner state becomes offline, including the sidebar and the shell banner. Existing Home data remains readable and review links remain available. Changing back restores fixture runner state. |

No-open and no-recent-completion messages are independent components; either can occur without the other. Empty preview presents both together for efficient review. A failed initial data load should retain the shell's connection/error handling and provide retry rather than silently display the no-projects state; detailed failure recovery is outside this layout decision.

## Components and integration

- `pages/home/index.vue` chooses `HomeDesktop` with `useDevice().isMobile`. Its existing mobile dashboard stays intact, with its existing filter, counts, Today stats, agents and epics. No duplicate mobile page or route is introduced.
- `HomeDesktop.vue`: layout composition, option/state controls, data projections from `useLive()`, sorting and the activity timeline.
- `HomeProjectSummary.vue`: one board link with `dashboardCounts()` and `projectColor()`; stage definitions remain the existing dashboard definitions.
- `HomeEpicList.vue`: open and completed rows, dates, review mode, attention text and both empty states. Open progress uses the existing `EpicProgressRow` and its accessible meter.
- Existing `UDashboardPanel`, `UButton`, `USkeleton`, `UIcon`, `NuxtLink`, `ShellBanners` and the real sidebar supply the presentation and navigation.
- The desktop global sidebar gains Home first, above Plan and Inbox, with a house icon, active colour and `aria-current`. The collapsed sidebar retains the icon. It links to `/home`.
- The `/` redirect override is guarded by `import.meta.prototype` in `setup.global.ts`. The proposed build should change the desktop root landing to `/home`, while preserving onboarding for installations with no projects. This design branch does not alter the production redirect policy.
- Static builds use the existing hash router, fixture API, bundled icons/fonts and relative assets. Serve `apps/web/prototype-dist/` under any sub-path; no backend is required. No services or real repositories were contacted while exercising it.

## Mock data shape

Typed contract fixtures live in `app/prototype/fixtures.ts`; existing mock routes serve projects, tasks, epics, runs and Inbox. Inbox now also derives an `EpicReviewItem` from the waiting epic PR, so the global count and destination agree.

| Fixture | Purpose |
| --- | --- |
| Corral | Busy project: all four in-progress stages, Backlog work, merged-today activity and an epic PR to review. Nothing blocked or failed. |
| Marketing site | A smaller, paused project with active website work and a recent completion. |
| Companion app | Blocked/failed project: one blocked and one failed task, its own Mobile app epic, Backlog work. Added in v2 so busy and blocked are different projects. |
| Notebook | Quiet project: zero in-progress work and no human attention; historical completions still visible. |
| Design tasks | 2/7 merged, work in flight, a human review, review-each-task mode. |
| Mobile app | Companion app. 1/3 merged, blocked and failed work, direct mode. |
| Website refresh | 0/2 merged, work starting, direct mode. |
| Runner updates | 4/4 merged into its epic branch, epic review mode, PR #82 in human review. Still open. |
| Pricing fixes | Completed minutes ago; 1 task. |
| Keyboard navigation | Completed 1 day ago; 2 tasks. |
| Search foundations | Completed 3 days ago; 2 tasks. |
| Release checklist | Completed 6 days ago; 2 tasks. |
| Legacy import | Completed 30 days ago; 2 tasks. Available by epic route but excluded from all Home options. |
| Future campaigns | Zero board tasks; omitted from open and completed lists. |

Times use the shared `ago(minutes)` helper, anchored when the fixture module loads. Epic counts are recomputed from non-Draft/non-Backlog task fixtures so opening a detail page preserves the progress shown on Home. Generated fixture tasks use the shared typed `task()` helper. Every Home epic has its own description. Design tasks now depends on Runner updates, because an epic dependency stays within a project. No new contract fields or migrations are introduced.

## Data gaps to settle before building

1. **Durable completion time:** `Epic` has no `completedAt` or epic PR merged timestamp. For direct-mode epics this preview uses the latest task `mergedAt`, falling back to `updatedAt` only if task timestamps are missing. `updatedAt` can move after a title edit and is not reliable completion data. For `epic`/`each_task`, latest task merge is not epic PR completion. The chosen build needs an authoritative epic completion/PR merge timestamp for accurate ordering and the 14-day window. No completed epic-branch fixture pretends otherwise: all recent completed examples are direct mode.
2. **Activity semantics:** `Epic.updatedAt` is used for “Updated … ago”. Confirm task activity always advances it; otherwise derive latest task/epic activity or expose a server-owned last activity timestamp. The prototype labels the timestamp as Updated, without claiming it is a run event.
3. **Merged vs shipped:** Progress counts merged board tasks in all review modes. An all-task-merged epic PR in review stays open as D23 requires. This is a refinement of the task brief's shorthand “all merged = completed”.
4. **Scale:** Existing project/task/epic lists suffice for this prototype and local POC. A later aggregate endpoint may be useful for many projects; it is not a prerequisite for choosing the layout.

## Rationale and trade-offs

**A — Projects at a glance.** Best when the first question is “which project needs my attention?” Equal cards make quiet and busy work equally discoverable. Open work and completions share the viewport. Trade-off: project cards consume vertical space as the project count grows, and long epic titles have less room in the split lower section.

**B — Keep the bigger picture moving.** Best for monitoring delivery across epics. The broad central list has room for titles, progress and review context; project totals remain adjacent. Trade-off: recent completions require scrolling, and the narrow rail repeats zero stage counts for quiet projects.

**C — A little attention goes a long way.** Best for a quick intervention followed by a chronological scan. A prominent review link turns the headline attention summary into a concrete next action. The combined timeline shows progress and finished work together, with project summaries on the left. Trade-off: open and completed epics are interleaved, so it takes more scanning to isolate only open work. Busy epics can push recent completions below the fold. It offers a stronger editorial hierarchy than A or B.

A is the most balanced default to discuss first; B favours delivery monitoring, C favours the human's next intervention. Selecting one should remove the other alternatives rather than preserve extra navigation controls.

## Review and verification

Counts and durations in every option use the shared `plural()` and `timeAgo()` helpers (“1 human review”, “1 to review”, “Updated 1h ago”).

Screenshots are captured with agent-browser from the built static bundle, served under `/prototype-dist/`, at 1440×900 for each option and empty state. Additional captures cover each option at 1280px, 1920px and 390px. The 390px option captures come from a non-touch browser: `isMobile` needs `(max-width: 767px) and (pointer: coarse)`, so that browser keeps the desktop layout and shows how the desktop page behaves when very narrow. `home-mobile-390.png` shows the existing mobile dashboard, captured with `corral.device.layout=mobile` in localStorage, and proves that page is unchanged. The evidence also records board and epic destinations after real clicks. Lint, typecheck and tests are gates, not visual acceptance evidence.

## Open questions

- Which hierarchy should lead: equal project summaries (A), delivery progress (B), or immediate decisions (C)?
- Should mobile Home adopt the chosen option's recently completed section in a follow-up?
- Is a trailing 14-day window preferable to a fixed last-N list, especially for quiet projects?
- Should the all-task-merged epic PR stay in Open epics as shown, or have a dedicated “Awaiting release review” subsection?
- Can the build add an authoritative epic completion timestamp, including the epic PR merge time, rather than relying on mutable `updatedAt`?
- Should paused projects remain equally prominent, as shown, or sort after unpaused projects?
