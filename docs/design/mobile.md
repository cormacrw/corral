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

- **Header:** the page title (on a project's Board, Backlog and Settings, the project name above it and a back button to the project's overview; on a project's overview, a back button to Projects and Project settings in place of Settings; on a Plan conversation, the project above the session title and a back button to `/plan`; on an Inbox item, "Inbox · n of m" above the task ref and a back button to `/inbox`), the runner's live status (a dot and "Runner online" / "Runner offline", coloured like the sidebar footer), and a Settings button. Pages add their own header buttons by teleporting into `#mobile-header-actions` (`<Teleport defer to="#mobile-header-actions">`), next to Settings: the Board's search, the Backlog's New task, Projects' Add project, Project settings' Save.
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

`/home` is a placeholder for now (a short summary), so every tab has a target. On the web it renders in the normal shell, as does `/projects` (a plain project list) and `/agents`' simple list.

## Agents

Built from the **Agents**, **Agent · Atlas** and **Agent · live run** frames. Behaviour follows [agent.md](agent.md); the web and mobile pages share `useAgentRuns()`.

- **Agents** (`/agents`): **Working now** cards (the agent, its live run's task, project, run number and elapsed time), then **Idle** rows (the PM's "Runs only when you message it in Plan", or the last run), then **Today**: runs, PRs merged and token usage across every agent. Status follows the live connection. Tapping an agent opens its page.
- **Agent** (`/agents/:name`): the header gets a back arrow to Agents and an **Agent settings** button in place of Settings. The avatar, name and status, the role's stat tiles (they scroll sideways), the facts line, the **Current run** card and **Previous runs**. Each run opens its transcript. Mobile doesn't auto-select a run here, unlike the web.
- **Run** (`/agents/:name/:runId`): full screen, without the shell's header or tab bar. Its own header has a back arrow to the agent, "{Agent} · Run #n", the task, **Open task** (goes to the task page), the outcome badge, elapsed time and tokens, and **Stop run** while live. The body is `RunTranscript`, thinking included, streamed while live. The footer is the same note as the web's (mid-run messages aren't supported yet), padded for the home indicator.

## Task and epic

- **Task** (`/tasks/<ref>`, frames *Task · details* and *Task · criteria and activity*): `TaskDetail` in `mobile` mode, a full page with no shell header or tab bar. Its header has a back arrow, the epic (linking to it) over the ref, copy link, and a **⋯** menu with **Delete task**. Under the title, a "{agent} is working · Watch" strip while an agent holds the task, then two tabs:
  - **Details:** the property rows (label and value, divided), Depends on, and the description.
  - **Criteria and activity:** acceptance criteria, then Activity, Evidence and History with the composer. `?evidence=1` opens this tab on Evidence.
- **Epic** (`/epics/<id>`, frame *Epic*): `EpicDetail` in `mobile` mode with its own header (back, an Epic badge and the project over the title, copy link) and the tab bar. The body is stacked like the flyout, with Tasks and Graph as a segmented control. Tapping a task, in the list or the graph, opens its page.
- **No flyout on mobile:** `useTaskFlyout().open()` and `openEpic()` go to `/tasks/<ref>` and `/epics/<id>` instead, so every place that opens a task (Board, Backlog, Plan, Agents) gets the page. Opening with `replace` (a page following its selection, like the Inbox) still sets the query.

## Projects

Built from the frames **Projects**, **Project overview** and **Project settings**. The behaviour is [project-overview.md](project-overview.md) and [project-settings.md](project-settings.md).

- **Projects** (`/projects`, `MobileProjects.vue`): header "Projects" with an Add project button. One card per project: the thumbnail, name, Running/Paused badge, and `owner/repo · PREFIX`, which opens the overview. Under it, one line: the agent holding a lease ("Atlas building COR-35", with the working dot), or for a paused project "No new runs start while paused." and how many items need you. The card ends in three cells: **Board** with the count of tasks on the board, **Backlog** with the Backlog count, and **Settings**. An outlined **Add project** button follows the cards.
- **Project overview** (`/projects/:slug`, `MobileProjectOverview.vue`): header "Overview" with Back (to Projects) and a Project settings button in place of Settings. The web page's sections in one column: the project header with **Plan with Juno** and **Open board** side by side, stat tiles that scroll sideways, Needs you as full-width rows (ref and title over the type badge and time), Active now, Epics with **Open Backlog**, and Recent activity. It shares its data with the web page through `useProjectOverview()`.
- **Project settings** (`/projects/:slug/settings`): the web page's cards, stacked, under the project page header (the project name over "Settings", Back to the overview) with the "Saved" note and **Save**, which follows the same rules as Save changes on the web.

## Inbox

Built from the **Inbox · Needs you**, **Inbox · Human review**, **Inbox · Question** and **Inbox · Blocked** frames. Behaviour follows [inbox.md](inbox.md); the page keeps its data and actions, and `InboxMobile.vue` lays them out. The list and the item are separate screens, not panes, on the same routes.

- **List** (`/inbox`): the filter tabs (**Needs you** and **Resolved** with counts), a search button in the header that shows the search box, and one row per item: the sender's avatar, name and time, the subject, a two-line preview, the type badge, and the project and task ref. Needs you ends with "That's everything that needs you." Tapping a row opens the item.
- **Item** (`/inbox/:itemId`): the header shows "Inbox · n of m" (its place in Needs you) above the task ref, a back button to the list, and a **Task** button that opens the task page; there's no task flyout. The body is the sender, subject, type badge, project and "{sender} · {role} · {time}", the agent's message, and on a human review the PR and passing-check chips and the criteria with their evidence.
- **Tray**, pinned to the bottom: the same quick actions and composer as the web. A question has no chips: the composer answers it (**Send answer**, which is Clarify and continue). Resolving an item moves on to the next one that needs you, as on the web; Back returns to the list.

## Pages without a mobile screen yet

They render inside the mobile layout as they are, and reflow as well as they can: panels stack or scroll sideways. Each later task replaces one group with its mobile screen.

## Remaining frames

Frames in the export, grouped by the task that will build them:

| Task | Frames |
|---|---|
| Home | Home |
| Settings | Settings, Settings · Runner |
| Search | Search |
| Onboarding | Setup · Your name, Setup · Repository, Setup · Agent CLIs, Setup · Name agents |
| Install | Install Corral (the PWA manifest and install prompt) |
