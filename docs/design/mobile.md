# Mobile shell

**Design:** the mobile PWA canvas, offline export [mobile-pwa.html](mobile-pwa.html) (open it in a browser)
**Decision:** [D17](../decisions.md#d17--a-mobile-pwa-layout-served-by-the-same-app)
**Routes:** the same as the web app. Mobile changes the layout, never the URL.

The page specs in this folder still set the behaviour. This page covers the shell that every mobile screen sits in, and which frames are still to build.

## Mobile or web

`app.vue` picks the layout at the root, through `useDevice()` (`app/composables/useDevice.ts`):

- **Mobile** when the screen is small and touch-first, `(max-width: 767px) and (pointer: coarse)`, or when Corral runs as an installed app, `(display-mode: standalone)`.
- **Web** otherwise. A narrow desktop window stays on the web layout, because its pointer is fine.
- Both media queries are watched, so rotating, resizing or installing switches the layout without a reload.
- Mobile renders `layouts/mobile.vue` in place of `layouts/default.vue`. Pages that set their own layout (onboarding's `bare`) keep it.

Pages and components use `useDevice().isMobile` to choose a mobile component. Don't add mobile-only routes.

## Page scale

The app shell fixes mobile page scale at 1 with the viewport meta (including
`viewport-fit=cover`). Root `touch-action: manipulation` prevents double-tap zoom
while allowing vertical and horizontal scrolling. On iOS, including iPadOS with a
desktop user agent, the shell cancels `gesturestart` and `gesturechange` once for
its mounted lifetime. Touch devices use at least 16px text in inputs, textareas,
selects and editable composers to avoid Safari focus zoom, including dialogs and
the Desktop layout override. Desktop keyboard zoom remains available.

## Override

**Settings → Appearance → Layout** is a segmented control: **Auto** (the rule above), **Desktop** or **Mobile**.

- It applies immediately, with no reload.
- It's saved in `localStorage` (`corral.device.layout`), so it belongs to this browser on this device and survives reloads. Auto removes the key.

## Mobile layout

From top to bottom:

- **Header:** On sub-pages, `MobilePageHeader` lives at the top of the scroll area and scrolls away with its content. Home, Plan, Inbox, Projects and Settings have no title row; their content starts at the top, with the mobile layout applying `env(safe-area-inset-top)`. Sub-pages keep their back link and accessible label: project Board, Backlog, Pull requests and Settings return to the overview with the project name and dot above the title; Overview returns to Projects with Project settings; Agent returns to Home with Agent settings; Settings sections return to Settings. Actions render directly in the row's `actions` slot: Board search, Backlog New task, Project settings Save and Add agent on the Agents settings screen. Inbox search sits on the right of the filter-tabs row; Projects keeps only the outlined Add project button after the cards. Phones have no Plan session switcher for now. There is no shell header or teleport target, and runner status appears only in Home.
- **Focused header:** Plan conversations and Inbox items keep a slim, non-scrolling `MobilePageHeader` above their body (back, eyebrow, title and actions). Plan shows the project above the session title and returns to `/plan`; Inbox shows “Inbox · n of m” above the task ref and returns to `/inbox`. The body takes the remaining height with its composer or action bar pinned at the bottom. Task, Epic and Run retain their own headers.
- **Banners:** the same shell banners as the web layout (stopped, updating, project paused, runner offline, reconnecting). The runner-offline banner shows only when no runner is online; offline runners next to an online one show only in the runner list, from `ShellBanners.vue`.
- **Page:** fills the space between, and scrolls.
- **Tab bar:** five tabs, each an icon over a label. The active tab is `primary`. A Plan conversation and an Inbox item hide the tab bar, so the chat, or the action bar and its composer, get the full height.

| Tab | Icon | Route | Active on | Indicator |
|---|---|---|---|---|
| Home | `layout-grid` | `/home` | `/home` | |
| Plan | `message-square` | `/plan` | `/plan/**` | Unread dot when a session is unread |
| Inbox | `inbox` | `/inbox` | `/inbox/**` | Badge with the live count of open items (Needs you) |
| Projects | `folder` | `/projects` | `/projects/**`, `/tasks/**`, `/epics/**` | |
| Settings | `settings` | `/settings` | `/settings`, `/settings/**` | |

- Tapping any tab goes back to Corral's first history entry in the browser tab and replaces it with that tab root, including when arriving on a deep link. It never goes past that entry, so pages from other sites earlier in the browser tab are left alone. Back or an iOS edge swipe at a tab root cannot revisit earlier tabs or details. Links into projects, tasks and threads still push normally, so Back walks through detail screens until the tab root. Desktop navigation is unchanged.
- Tab-root content, sub-page headers and the tab bar pad themselves with `env(safe-area-inset-*)`, and the viewport uses `viewport-fit=cover`, so nothing sits under a notch or the home indicator.
- Toasts appear at the top centre on mobile, 1rem below `env(safe-area-inset-top)`, keeping the tab bar and composers clear. Desktop keeps Nuxt UI's default bottom-right position. Dismissal and automatic closing use Nuxt UI's defaults.
- Home’s runner status and the Inbox count come from the shell queries (`useShell()`), which the app's one live connection keeps current, so they update without a reload.

On the web, `/projects` renders in the normal shell as a plain project list.

## Home

`/home` is the global dashboard, counted from the live task lists so it matches each project's Board and updates without a reload:

- **Runner status** ("Runner online", or "{online} of {total} runners online" with several) and a project filter (**All projects** or one project) · **Today**. Runner status is shown only here.
- **Tiles:** **To do** (Ready), **In progress** (In progress, Agent review, Human review and Ready to merge) and **Completed today** (tasks merged and designs approved since local midnight) with how many merged tasks were first-pass (no changes requested).
- **Today totals**, immediately after the count tiles: **Runs** and **Usage**, from `todayStats` (`utils/agents.ts`), counting today’s queued runs and their input plus output tokens. Both respect the project filter. The note reads "Usage is in tokens from your own subscription." Completed today already covers PRs merged.
- **In progress by stage:** a bar and counts per stage, and a link to the Inbox with the blocked (Blocked and Failed) and waiting-for-your-review (Human review) counts.
- **Agents:** each agent with small muted text only for Paused or Waiting on usage limit; working agents first, indicated by their border, ring and animated avatar, with each active run's task, project, status, run number (PR number for reviews) and elapsed time. Runs come from `GET /api/runs`, refetched on `run.updated`; the cards show only active runs. Tapping an agent opens its agent page.

- **Epics**, below Agents: live epics with at least one non-Draft task and fewer merged tasks than total tasks, newest updated first. Rows link to the epic and show “N of M merged” with an accessible two-segment meter. All projects shows the project name and colour dot; selecting one project hides those labels. When none qualify, show “No epics in progress.”

## Agents

Agent detail and run screens follow [agent.md](agent.md); the web and mobile pages share `useAgentRuns()`. The former Agents list is retired: `/agents` redirects to `/home` on both layouts. Home’s Agents cards and the web sidebar open individual agents.

- **Agent** (`/agents/:name`): the header gets a back arrow to Home (`/home`) and an **Agent settings** button; no tab is active. The avatar, name and status, the role's stat tiles (they scroll sideways), the facts line, the **Current run** card and **Previous runs**. Current and previous PM turns with a linked Plan session open `/plan/:sessionId?project=:projectId`, using that run’s session and project so the conversation can be continued. Runs without a linked session and all developer, designer and reviewer runs open their transcripts. Mobile doesn't auto-select a run here, unlike the web.
- **Run** (`/agents/:name/:runId`): full screen, without the shell's header or tab bar. Its own header has a back arrow to the agent, "{Agent} · Run #n", the task, **Open task** (goes to the task page), the outcome badge, elapsed time and tokens (input, cache read and output), and **Stop run** while live. The body starts with the run timing breakdown when the run has timings ([agent.md](agent.md)), then `RunTranscript`, thinking included, streamed while live. The footer is the same as the web's (the composer while live, disabled with the reason on a Codex run, the read-only note once finished), padded for the home indicator.

## Task and epic

- **Task** (`/tasks/<ref>`, frames *Task · details* and *Task · criteria and activity*): `TaskDetail` in `mobile` mode, a full page with no shell header or tab bar. Its header has a back arrow, the epic (linking to it) over the ref, copy link, and a **⋯** menu with **Delete task**. Under the title, a "{agent} is working · Watch" strip while an agent holds the task, then two tabs:
  - **Paused:** a paused task shows the same bar and **Resume** button as the other modes ([task.md](task.md)), above the tabs so it stays on both, with a 44px tap target.
  - **Details:** the property rows (label and value, divided), Depends on, and the description.
  - **Criteria and activity:** acceptance criteria, then Activity, Evidence and History with the composer. `?evidence=1` opens this tab on Evidence.
- **Epic** (`/epics/<id>`, frame *Epic*): `EpicDetail` in `mobile` mode with its own header (back, an Epic badge and the project over the title, copy link) and the tab bar. The body is stacked like the flyout, with Tasks and Graph as a segmented control. Tapping a task, in the list or the graph, opens its page.
- **No flyout on mobile:** `useTaskFlyout().open()` and `openEpic()` go to `/tasks/<ref>` and `/epics/<id>` instead, so every place that opens a task (Board, Backlog, Plan, Agents) gets the page. Opening with `replace` (a page following its selection, like the Inbox) still sets the query.

## Plan

The mobile `/plan` tab starts directly with the planning prompt, with no title row. Phones have no session switcher for now, including in focused conversations; desktop keeps its session controls. Focused conversations retain their compact header, back button, project eyebrow, title and New session action.

## Projects

Built from the frames **Projects**, **Project overview** and **Project settings**. The behaviour is [project-overview.md](project-overview.md) and [project-settings.md](project-settings.md).

- **Projects** (`/projects`, `MobileProjects.vue`): no title row or header Add project icon. One card per project: the thumbnail, name, Paused badge only while paused, and `owner/repo · PREFIX`, which opens the overview. Under it, one line: the agent holding a lease ("Atlas building COR-35", with the working dot), or for a paused project "No new runs start while paused." and how many items need you. The card ends in four cells: **Board** with the count of tasks on the board that are not complete (recently completed work still shows in the Board's Complete column but is left out of this count), **Backlog** with the Backlog count, **PRs** (the Pull requests page), and **Settings**. An outlined **Add project** button follows the cards.
- **Project overview** (`/projects/:slug`, `MobileProjectOverview.vue`): header "Overview" with Back (to Projects) and a Project settings button. The web page's sections in one column: the project header with **Plan with Juno** and **Open board** side by side, stat tiles that scroll sideways, the Flow section ([project-overview.md](project-overview.md#charts)), Needs you as full-width rows (ref and title over the type badge and time), Active now, Epics with **Open Backlog**, and Recent activity. It shares its data with the web page through `useProjectOverview()`. The overview root is the single vertical scroller bounded by the layout above the tab bar and its bottom safe-area padding; its header and sections flow together without an inner scroller.
- **Project settings** (`/projects/:slug/settings`): the web page's cards, stacked, under the project page header (the project name over "Settings", Back to the overview) with the "Saved" note and **Save**, which follows the same rules as Save changes on the web.

## Inbox

Built from the **Inbox · Needs you**, **Inbox · Human review**, **Inbox · Question** and **Inbox · Blocked** frames. Behaviour follows [inbox.md](inbox.md); the pages keep their data and actions, `InboxMobile.vue` lays out the list and `InboxMobileItem.vue` the item around `InboxPanel`. The list and the item are separate screens, not panes, on the same routes.

- **List** (`/inbox`): the filter tabs (**Inbox**, the web's Needs you, and **Resolved** with counts), a Search the Inbox button on the right of the filter-tabs row that toggles the search box, and one row per item: the sender's avatar, name and time, the subject, a two-line preview, the type badge, and the project and task ref. Inbox lists items newest first, Plan threads among them with no group, and ends with "That's everything in your Inbox." Tapping a row opens the item.
- **Item** (`/inbox/:itemId`): the header shows "Inbox · n of m" (its place in Needs you) above the task ref, a back button to the list, and a **Task** button that opens the task page; there's no task flyout. Task items are the Option D panel, `InboxPanel` in `mobile` mode ([inbox.md](inbox.md#2-selected-message)), so everything needed to decide fits at 390×844 without scrolling: the meta line, the title, the shared `InboxMessage` clamped to three lines with its **New** row (or the TL;DR on items with no `message`), the verdict, and the PR or Preview link. Below them are the same tabs as the web, which scroll sideways on their own row; screenshots sit in two columns.
- Files in the **New** row open the existing evidence viewer in one tap; new design versions link to their preview. Only `newArtifacts` are marked New; older files remain in the criteria evidence list. An empty array produces no row. The **Message** tab shows the full body, including spike findings. Items without `message` retain their existing body.
- **Plan threads** (open Plan sessions with a question or a plan needing approval): the row shows the sender's avatar, name and time, the session title, the preview, and the status badge beside the project tag; the item shows only the question, or the plan with View plan, Approve to board and Approve to Backlog, not the conversation, with **Open in Plan** in place of the Task button and **Delete thread** in its menu. An unread reply shows Juno's latest reply with a reply box. Thread rows swipe left to **Delete**, with a 5-second Undo toast; task rows don't swipe. See [inbox.md](inbox.md#mobile).
- **Action bar** (`InboxPanelThumbBar`), fixed at the bottom of an item you can act on: every action as a target at least 64px tall, within thumb reach, padded for the home indicator, followed by **Reply** unless the host leaves it out. Labels are shortened to fit (**Send back**, **Delete**), and the approve label can be passed in; otherwise it's the action's own (Approve and merge, Accept findings, Approve design). Delete stays in the bar on blocked and failed items, so every action is one tap away. A failed item keeps Retry's status picker just above the bar.
- **Composer** (`InboxPanelTray`): **Request changes**, **Answer**, **Delete** and **Reply** open it above the bar; Delete takes an optional reason, as on the web. A question opens with Answer already chosen. Approve, Retry and Send back send on the tap, through the same composer, so a draft and its images go with them. Cancel and toggling Reply off keep the composer visible while it contains text or attached images; clear the draft and remove its images to close it. Unticked human checks stop approval as on the web: nothing is sent, the Criteria tab opens and the bar says why. Resolving an item moves on to the next one that needs you; Back returns to the list.
- **Read-only items** (Activity and Resolved): the same panel with no action bar. Overview shows the resolution or "For your information. Nothing to do."

## Install

Built from the **Install Corral** frame. Corral is an installable PWA, served by the same app at the same URLs.

- **Manifest** (`public/manifest.webmanifest`): name and short name "Corral", 192 and 512 px icons plus a maskable 512, `display: standalone`, white theme and background, `start_url` and `scope` of `/`. Every path is relative to the origin, because Corral runs behind whatever hostname the Cloudflare Tunnel gives it (D12). The manifest link, `theme-color` (light and dark) and the iOS tags (`apple-mobile-web-app-capable`, `apple-touch-icon`) are in `nuxt.config.ts`'s `app.head`, so they're in the static shell before any script runs.
- **Service worker** (`public/sw.js`, registered by `plugins/pwa.client.ts` in production builds only): caches the built app shell only. Pages are network first, falling back to the cached shell; content-hashed `/_nuxt/` files are cache first; the icons and manifest are network first. It never handles `/api/**` (the `/api/events` stream included), server-sent events, WebSocket upgrades, writes or other origins, and never caches a redirect (a Cloudflare Access sign-in) or an error. `utils/service-worker.test.ts` runs it against those requests.
- **Install screen** (`InstallSheet.vue`): a bottom sheet on mobile, a modal on the web, opened from **Settings → App → Install Corral**. `useInstall()` decides what it offers (`utils/install.ts`):
  - Chrome and Android: when `beforeinstallprompt` has fired, **Install app** shows the browser's prompt. The plugin catches the event early and suppresses Chrome's own mini-bar.
  - iOS (iPadOS included), which has no prompt: the three Add to Home Screen steps.
  - Already running standalone, or a browser that can't install: no Settings entry, and the sheet closes.
- Launched from the home screen, `(display-mode: standalone)` matches, so `useDevice()` picks the mobile layout whatever the window size. The setup middleware resolves this mode before redirecting: with a project, `/` and completed `/setup` open `/home` on mobile; desktop keeps the first project overview. With no projects, both layouts open onboarding, and `/setup?add=1` keeps the add-project flow.

## Setup

Built from the **Setup · Your name**, **Setup · Repository**, **Setup · Agent CLIs** and **Setup · Name agents** frames. Behaviour follows [onboarding.md](onboarding.md); the web page and `SetupMobile.vue` share their state and actions through `useSetup()`.

- Setup keeps the `bare` layout on mobile, so there's no shell header or tab bar.
- **Header:** the Corral logo and "Self-hosted" on step 1; on later steps a back arrow (to the previous step) and the step's title. The add-project flow's back arrow goes to Projects.
- **Progress:** four segments filled up to the current step, and "Step n of 4 · {step}" under them, in place of the web's stepper. The add-project flow has none.
- **Body:** the step's fields in one column, with no card: step 1 asks "What should agents call you?"; step 2 stacks the repository list, branch and merge method, and the setup checks in a bordered card; step 3 shows each CLI as a card-style checkbox, tinted `primary` when ready; step 4 is one card per role with its Name and Runs on fields.
- **Footer:** the step's action (Continue, Confirm and continue, Finish setup, Add project) full width, pinned to the bottom and padded for the home indicator.

## Settings

Built from the **Settings** and **Settings · Runner** frames. Behaviour follows [settings.md](settings.md).

- **Settings** (`/settings`, `SettingsMobile.vue`): on mobile, `/settings` lists the sections instead of opening Profile. This is a top-level tab with no title row. From the top: your picture and name (opens Profile), **Profile** and **Runners** rows (the runners row shows the live status, "Online · {name}" for one runner or "Online · {online} of {total} online" for several, with the dot), **Agents** (one row per agent with its role and runtime; developer and reviewer rows have a compact inline `ConcurrencyStepper` on the right, keeping 44px −/+ tap targets and saving in place without navigating; tapping the avatar, name or role opens `/settings/agents#agent-<id>` scrolled to that card; the PM keeps “one turn per session” and has no stepper), **Appearance** with the colour mode and the **Layout** override (Auto / Desktop / Mobile, see [Override](#override)) set in place, and **App → Install Corral** where the browser can install it.
- **Sections** (`/settings/<section>`): each its own screen, titled with the section, with a back button to `/settings`. Profile and Appearance show the web cards stacked, without the section menu.
- **Runners** (`/settings/runner`, `SettingsRunnerMobile.vue`): the card with the runner list from [settings.md](settings.md) (name, state badge, slots in use, runtimes, roles, last heartbeat, live from `useLive()`) and **Reconnect**, which reloads the live state and scans the logins again; the data directory (`CORRAL_RUNNER_DATA_DIR`, read-only); **Logins inside the runner** with each CLI's version and Signed in / Not signed in; the sign-in commands with a copy button each; and the note that Corral never reads credentials.

- **Agents** (`/settings/agents`, `SettingsAgentsMobile.vue`): header “Agents”, Back to Settings and **Add agent**, which opens the existing agent form as a bottom sheet. One full-width card per agent, with avatar, name, role, runtime and a Paused badge when paused. **Concurrency** comes first, using the large `ConcurrencyStepper`; the PM instead says “One turn per Plan session” and has no concurrency or wake interval control. A full-width **Paused** switch row has a 44px tap target. **More settings** starts collapsed and reveals full-width Name, Runtime (disabled with “Changes once its runs end” while active), Wake interval in minutes (blank means every check), and Picture Upload / Remove. Changes save through the same APIs as desktop. A bottom **Kill switch** card has a full-width **Stop everything** / **Resume everything** button. Links to `#agent-<id>` scroll that card into view, including after the agents load. The desktop section keeps its existing layout.

## Search

Mobile has no global Search button or command palette. Board, Backlog and the Inbox list retain their own in-page search. The desktop command palette (`layouts/default.vue`, `utils/search.ts`) remains available through its Search button and ⌘K/Ctrl+K.

## Pages without a mobile screen yet

They render inside the mobile layout as they are, and reflow as well as they can: panels stack or scroll sideways. Each later task replaces one group with its mobile screen.

## Remaining frames

None: every frame in the export has its mobile screen.
