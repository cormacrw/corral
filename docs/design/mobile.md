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

- **Header:** the page title (on a project's Board, Backlog and Settings, the project name above it and a back button to the project's overview), the runner's live status (a dot and "Runner online" / "Runner offline", coloured like the sidebar footer), and a Settings button. Pages add their own header buttons by teleporting into `#mobile-header-actions` (`<Teleport defer to="#mobile-header-actions">`), next to Settings: the Board's search, the Backlog's New task.
- **Banners:** the same shell banners as the web layout (stopped, updating, project paused, runner offline, reconnecting), from `ShellBanners.vue`.
- **Page:** fills the space between, and scrolls.
- **Tab bar:** five tabs, each an icon over a label. The active tab is `primary`.

| Tab | Icon | Route | Active on | Indicator |
|---|---|---|---|---|
| Home | `layout-grid` | `/home` | `/home` | |
| Plan | `message-square` | `/plan` | `/plan/**` | Unread dot when a session is unread |
| Inbox | `inbox` | `/inbox` | `/inbox/**` | Badge with the live count of open items (Needs you) |
| Projects | `folder` | `/projects` | `/projects/**`, `/tasks/**`, `/epics/**` | |
| Agents | `bot` | `/agents` | `/agents/**` | |

- The header and tab bar pad themselves with `env(safe-area-inset-*)`, and the viewport uses `viewport-fit=cover`, so nothing sits under a notch or the home indicator.
- The runner status and Inbox count come from the app's one live connection (`useLive()`), so they update without a reload.

`/projects` and `/agents` are placeholders for now (the project list and the agent list), so every tab has a target. On the web they render in the normal shell.

## Home

`/home` is the global dashboard, counted from the live task lists so it matches each project's Board and updates without a reload:

- **Runner status** and a project filter (**All projects** or one project) · **Today**. The header hides its own runner status on Home.
- **Tiles:** **To do** (Ready), **In progress** (In progress, Agent review, Human review and Ready to merge) and **Merged today** (merged since local midnight) with how many were first-pass (no changes requested).
- **In progress by stage:** a bar and counts per stage, and a link to the Inbox with the blocked (Blocked and Failed) and waiting-for-your-review (Human review) counts.
- **Agents:** each agent with Working, Idle or Paused; working agents first, with each active run's task, project, status, run number (PR number for reviews) and elapsed time. Active runs come from `GET /api/runs?active=1`, refetched on `run.updated`. Tapping an agent opens its agent page.
- **By project:** To do, In progress and Merged today per project, with a Paused badge. Tapping a row opens the project's overview.

## Pages without a mobile screen yet

They render inside the mobile layout as they are, and reflow as well as they can: panels stack or scroll sideways. Each later task replaces one group with its mobile screen.

## Remaining frames

Frames in the export, grouped by the task that will build them:

| Task | Frames |
|---|---|
| Inbox | Inbox, Inbox · Human review, Inbox · Question, Inbox · Blocked |
| Plan | Plan · New session, Plan · Conversation, Plan · Plan v2, Plan · Runner offline |
| Projects | Projects, Project overview, Project settings (Board and Backlog are built, see [board.md](board.md) and [backlog.md](backlog.md)) |
| Task and epic | Task COR-35, Task COR-35 · Activity, Epic · Billing |
| Agents | Agents, Agent · Atlas, Run #128 |
| Settings | Settings, Settings · Runner |
| Search | Search |
| Onboarding | Setup · Your name, Setup · Repository, Setup · Agent CLIs, Setup · Name agents |
| Install | Install Corral (the PWA manifest and install prompt) |
