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

## Override

**Settings → Appearance → Layout** is a segmented control: **Auto** (the rule above), **Desktop** or **Mobile**.

- It applies immediately, with no reload.
- It's saved in `localStorage` (`corral.device.layout`), so it belongs to this browser on this device and survives reloads. Auto removes the key.

## Mobile layout

From top to bottom:

- **Header:** the page title (on a project's Board, Backlog and Settings, the project name above it and a back button to the project's overview; on a project's overview, a back button to Projects and Project settings in place of Settings; on a Plan conversation, the project above the session title and a back button to `/plan`; on an Inbox item, "Inbox · n of m" above the task ref and a back button to `/inbox`), the runner's live status (a dot and "Runner online" / "Runner offline", coloured like the sidebar footer), a Search button that opens [Search](#search), and a Settings button (to `/settings`). The Board, Backlog and Inbox list have their own search button that filters the page, so they don't show the global one. Pages add their own header buttons by teleporting into `#mobile-header-actions` (`<Teleport defer to="#mobile-header-actions">`), next to Settings: the Board's search, the Backlog's New task, Projects' Add project, Project settings' Save.
- **Banners:** the same shell banners as the web layout (stopped, updating, project paused, runner offline, reconnecting), from `ShellBanners.vue`.
- **Page:** fills the space between, and scrolls.
- **Tab bar:** five tabs, each an icon over a label. The active tab is `primary`. A Plan conversation and an Inbox item hide the tab bar, the runner status and Settings, so the chat or the tray and its composer get the full height.

| Tab | Icon | Route | Active on | Indicator |
|---|---|---|---|---|
| Home | `layout-grid` | `/home` | `/home` | |
| Plan | `message-square` | `/plan` | `/plan/**` | Unread dot when a session is unread |
| Inbox | `inbox` | `/inbox` | `/inbox/**` | Badge with the live count of open items (Needs you) |
| Projects | `folder` | `/projects` | `/projects/**`, `/tasks/**`, `/epics/**` | |
| Agents | `bot` | `/agents` | `/agents/**` | |

- The header and tab bar pad themselves with `env(safe-area-inset-*)`, and the viewport uses `viewport-fit=cover`, so nothing sits under a notch or the home indicator.
- The runner status and Inbox count come from the app's one live connection (`useLive()`), so they update without a reload.

On the web, `/projects` renders in the normal shell as a plain project list, as does `/agents`' simple list.

## Home

`/home` is the global dashboard, counted from the live task lists so it matches each project's Board and updates without a reload:

- **Runner status** and a project filter (**All projects** or one project) · **Today**. The header hides its own runner status on Home.
- **Tiles:** **To do** (Ready), **In progress** (In progress, Agent review, Human review and Ready to merge) and **Merged today** (merged since local midnight) with how many were first-pass (no changes requested).
- **In progress by stage:** a bar and counts per stage, and a link to the Inbox with the blocked (Blocked and Failed) and waiting-for-your-review (Human review) counts.
- **Agents:** each agent with Working, Idle or Paused; working agents first, with each active run's task, project, status, run number (PR number for reviews) and elapsed time. Active runs come from `GET /api/runs?active=1`, refetched on `run.updated`. Tapping an agent opens its agent page.
- **By project:** To do, In progress and Merged today per project, with a Paused badge. Tapping a row opens the project's overview.

## Agents

Built from the **Agents**, **Agent · Atlas** and **Agent · live run** frames. Behaviour follows [agent.md](agent.md); the web and mobile pages share `useAgentRuns()`.

- **Agents** (`/agents`): **Working now** cards (the agent, its live run's task, project, run number and elapsed time), then **Idle** rows (the PM's "Runs only when you message it in Plan", or the last run), then **Today**: runs, PRs merged and token usage across every agent. Status follows the live connection. Tapping an agent opens its page.
- **Agent** (`/agents/:name`): the header gets a back arrow to Agents and an **Agent settings** button in place of Settings. The avatar, name and status, the role's stat tiles (they scroll sideways), the facts line, the **Current run** card and **Previous runs**. Each run opens its transcript. Mobile doesn't auto-select a run here, unlike the web.
- **Run** (`/agents/:name/:runId`): full screen, without the shell's header or tab bar. Its own header has a back arrow to the agent, "{Agent} · Run #n", the task, **Open task** (goes to the task page), the outcome badge, elapsed time and tokens (input, cache read and output), and **Stop run** while live. The body is `RunTranscript`, thinking included, streamed while live. The footer is the same as the web's (the composer while live, disabled with the reason on a Codex run, the read-only note once finished), padded for the home indicator.

## Task and epic

- **Task** (`/tasks/<ref>`, frames *Task · details* and *Task · criteria and activity*): `TaskDetail` in `mobile` mode, a full page with no shell header or tab bar. Its header has a back arrow, the epic (linking to it) over the ref, copy link, and a **⋯** menu with **Delete task**. Under the title, a "{agent} is working · Watch" strip while an agent holds the task, then two tabs:
  - **Details:** the property rows (label and value, divided), Depends on, and the description.
  - **Criteria and activity:** acceptance criteria, then Activity, Evidence and History with the composer. `?evidence=1` opens this tab on Evidence.
- **Epic** (`/epics/<id>`, frame *Epic*): `EpicDetail` in `mobile` mode with its own header (back, an Epic badge and the project over the title, copy link) and the tab bar. The body is stacked like the flyout, with Tasks and Graph as a segmented control. Tapping a task, in the list or the graph, opens its page.
- **No flyout on mobile:** `useTaskFlyout().open()` and `openEpic()` go to `/tasks/<ref>` and `/epics/<id>` instead, so every place that opens a task (Board, Backlog, Plan, Agents) gets the page. Opening with `replace` (a page following its selection, like the Inbox) still sets the query.

## Projects

Built from the frames **Projects**, **Project overview** and **Project settings**. The behaviour is [project-overview.md](project-overview.md) and [project-settings.md](project-settings.md).

- **Projects** (`/projects`, `MobileProjects.vue`): header "Projects" with an Add project button. One card per project: the thumbnail, name, Running/Paused badge, and `owner/repo · PREFIX`, which opens the overview. Under it, one line: the agent holding a lease ("Atlas building COR-35", with the working dot), or for a paused project "No new runs start while paused." and how many items need you. The card ends in four cells: **Board** with the count of tasks on the board, **Backlog** with the Backlog count, **PRs** (the Pull requests page), and **Settings**. An outlined **Add project** button follows the cards.
- **Project overview** (`/projects/:slug`, `MobileProjectOverview.vue`): header "Overview" with Back (to Projects) and a Project settings button in place of Settings. The web page's sections in one column: the project header with **Plan with Juno** and **Open board** side by side, stat tiles that scroll sideways, Needs you as full-width rows (ref and title over the type badge and time), Active now, Epics with **Open Backlog**, and Recent activity. It shares its data with the web page through `useProjectOverview()`.
- **Project settings** (`/projects/:slug/settings`): the web page's cards, stacked, under the project page header (the project name over "Settings", Back to the overview) with the "Saved" note and **Save**, which follows the same rules as Save changes on the web.

## Inbox

Built from the **Inbox · Needs you**, **Inbox · Human review**, **Inbox · Question** and **Inbox · Blocked** frames. Behaviour follows [inbox.md](inbox.md); the page keeps its data and actions, and `InboxMobile.vue` lays them out. The list and the item are separate screens, not panes, on the same routes.

- **List** (`/inbox`): the filter tabs (**Needs you** and **Resolved** with counts), a search button in the header that shows the search box, and one row per item: the sender's avatar, name and time, the subject, a two-line preview, the type badge, and the project and task ref. Needs you ends with "That's everything that needs you." Tapping a row opens the item.
- **Item** (`/inbox/:itemId`): the header shows "Inbox · n of m" (its place in Needs you) above the task ref, a back button to the list, and a **Task** button that opens the task page; there's no task flyout. The body is the sender, subject, type badge, project and "{sender} · {role} · {time}", the agent's message, and on a human review the PR and passing-check chips and the criteria with their evidence.
- **Tray**, pinned to the bottom: the same quick actions and composer as the web. A question has no chips: the composer answers it (**Send answer**, which is Clarify and continue). Resolving an item moves on to the next one that needs you, as on the web; Back returns to the list.

## Install

Built from the **Install Corral** frame. Corral is an installable PWA, served by the same app at the same URLs.

- **Manifest** (`public/manifest.webmanifest`): name and short name "Corral", 192 and 512 px icons plus a maskable 512, `display: standalone`, white theme and background, `start_url` and `scope` of `/`. Every path is relative to the origin, because Corral runs behind whatever hostname the Cloudflare Tunnel gives it (D12). The manifest link, `theme-color` (light and dark) and the iOS tags (`apple-mobile-web-app-capable`, `apple-touch-icon`) are in `nuxt.config.ts`'s `app.head`, so they're in the static shell before any script runs.
- **Service worker** (`public/sw.js`, registered by `plugins/pwa.client.ts` in production builds only): caches the built app shell only. Pages are network first, falling back to the cached shell; content-hashed `/_nuxt/` files are cache first; the icons and manifest are network first. It never handles `/api/**` (the `/api/events` stream included), server-sent events, WebSocket upgrades, writes or other origins, and never caches a redirect (a Cloudflare Access sign-in) or an error. `utils/service-worker.test.ts` runs it against those requests.
- **Install screen** (`InstallSheet.vue`): a bottom sheet on mobile, a modal on the web, opened from **Settings → App → Install Corral**. `useInstall()` decides what it offers (`utils/install.ts`):
  - Chrome and Android: when `beforeinstallprompt` has fired, **Install app** shows the browser's prompt. The plugin catches the event early and suppresses Chrome's own mini-bar.
  - iOS (iPadOS included), which has no prompt: the three Add to Home Screen steps.
  - Already running standalone, or a browser that can't install: no Settings entry, and the sheet closes.
- Launched from the home screen, `(display-mode: standalone)` matches, so `useDevice()` picks the mobile layout whatever the window size.

## Setup

Built from the **Setup · Your name**, **Setup · Repository**, **Setup · Agent CLIs** and **Setup · Name agents** frames. Behaviour follows [onboarding.md](onboarding.md); the web page and `SetupMobile.vue` share their state and actions through `useSetup()`.

- Setup keeps the `bare` layout on mobile, so there's no shell header or tab bar.
- **Header:** the Corral logo and "Self-hosted" on step 1; on later steps a back arrow (to the previous step) and the step's title. The add-project flow's back arrow goes to Projects.
- **Progress:** four segments filled up to the current step, and "Step n of 4 · {step}" under them, in place of the web's stepper. The add-project flow has none.
- **Body:** the step's fields in one column, with no card: step 1 asks "What should agents call you?"; step 2 stacks the repository list, branch and merge method, and the setup checks in a bordered card; step 3 shows each CLI as a card-style checkbox, tinted `primary` when ready; step 4 is one card per role with its Name and Runs on fields.
- **Footer:** the step's action (Continue, Confirm and continue, Finish setup, Add project) full width, pinned to the bottom and padded for the home indicator.

## Settings

Built from the **Settings** and **Settings · Runner** frames. Behaviour follows [settings.md](settings.md).

- **Settings** (`/settings`, `SettingsMobile.vue`): on mobile, `/settings` lists the sections instead of opening Profile. The header has a back button to Home and no runner status or Settings button. From the top: your picture and name (opens Profile), **Profile** and **Runner** rows (the runner row shows its live status, "Online · {name}" with the dot), **Agents** (one row per agent with its role, runtime and concurrency, opening the Agents section), **Appearance** with the colour mode and the **Layout** override (Auto / Desktop / Mobile, see [Override](#override)) set in place, and **App → Install Corral** where the browser can install it.
- **Sections** (`/settings/<section>`): each its own screen, titled with the section, with a back button to `/settings`. Profile, Agents and Appearance show the web cards stacked, without the section menu.
- **Runner** (`/settings/runner`, `SettingsRunnerMobile.vue`): the status card (dot, "Online · {name}", last heartbeat, live from `useLive()`) with **Reconnect**, which reloads the live state and scans the logins again; the data directory (`CORRAL_RUNNER_DATA_DIR`, read-only); **Logins inside the runner** with each CLI's version and Signed in / Not signed in; the sign-in commands with a copy button each; and the note that Corral never reads credentials.

## Search

Built from the **Search** frame (`MobileSearch.vue`): the web's command palette as a full screen over the shell, opened from the header's Search button. The search box (focused) and **Cancel** sit at the top. With no query it lists the pages to go to; a query matches, case-insensitively, **Go to** pages (the same list as the web palette, `utils/search.ts`), **Epics** (with the project and merged count), **Tasks** (by title or ref, with the status), and **Plan sessions** (with the time), the matched text in bold. Each group shows up to 8 results. Picking one goes to it and closes Search; so does navigating away.

## Pages without a mobile screen yet

They render inside the mobile layout as they are, and reflow as well as they can: panels stack or scroll sideways. Each later task replaces one group with its mobile screen.

## Remaining frames

None: every frame in the export has its mobile screen.
