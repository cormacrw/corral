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

`/home` and `/projects` are placeholders for now (a short summary and the project list), so every tab has a target. On the web they render in the normal shell, as does `/agents`' simple list.

## Agents

Built from the **Agents**, **Agent · Atlas** and **Agent · live run** frames. Behaviour follows [agent.md](agent.md); the web and mobile pages share `useAgentRuns()`.

- **Agents** (`/agents`): **Working now** cards (the agent, its live run's task, project, run number and elapsed time), then **Idle** rows (the PM's "Runs only when you message it in Plan", or the last run), then **Today**: runs, PRs merged and token usage across every agent. Status follows the live connection. Tapping an agent opens its page.
- **Agent** (`/agents/:name`): the header gets a back arrow to Agents and an **Agent settings** button in place of Settings. The avatar, name and status, the role's stat tiles (they scroll sideways), the facts line, the **Current run** card and **Previous runs**. Each run opens its transcript. Mobile doesn't auto-select a run here, unlike the web.
- **Run** (`/agents/:name/:runId`): full screen, without the shell's header or tab bar. Its own header has a back arrow to the agent, "{Agent} · Run #n", the task, **Open task** (goes to the task page), the outcome badge, elapsed time and tokens, and **Stop run** while live. The body is `RunTranscript`, thinking included, streamed while live. The footer is the same note as the web's (mid-run messages aren't supported yet), padded for the home indicator.

## Install

Built from the **Install Corral** frame. Corral is an installable PWA, served by the same app at the same URLs.

- **Manifest** (`public/manifest.webmanifest`): name and short name "Corral", 192 and 512 px icons plus a maskable 512, `display: standalone`, white theme and background, `start_url` and `scope` of `/`. Every path is relative to the origin, because Corral runs behind whatever hostname the Cloudflare Tunnel gives it (D12). The manifest link, `theme-color` (light and dark) and the iOS tags (`apple-mobile-web-app-capable`, `apple-touch-icon`) are in `nuxt.config.ts`'s `app.head`, so they're in the static shell before any script runs.
- **Service worker** (`public/sw.js`, registered by `plugins/pwa.client.ts` in production builds only): caches the built app shell only. Pages are network first, falling back to the cached shell; content-hashed `/_nuxt/` files are cache first; the icons and manifest are network first. It never handles `/api/**` (the `/api/events` stream included), server-sent events, WebSocket upgrades, writes or other origins, and never caches a redirect (a Cloudflare Access sign-in) or an error. `utils/service-worker.test.ts` runs it against those requests.
- **Install screen** (`InstallSheet.vue`): a bottom sheet on mobile, a modal on the web, opened from **Settings → App → Install Corral**. `useInstall()` decides what it offers (`utils/install.ts`):
  - Chrome and Android: when `beforeinstallprompt` has fired, **Install app** shows the browser's prompt. The plugin catches the event early and suppresses Chrome's own mini-bar.
  - iOS (iPadOS included), which has no prompt: the three Add to Home Screen steps.
  - Already running standalone, or a browser that can't install: no Settings entry, and the sheet closes.
- Launched from the home screen, `(display-mode: standalone)` matches, so `useDevice()` picks the mobile layout whatever the window size.

## Pages without a mobile screen yet

They render inside the mobile layout as they are, and reflow as well as they can: panels stack or scroll sideways. Each later task replaces one group with its mobile screen.

## Remaining frames

Frames in the export, grouped by the task that will build them:

| Task | Frames |
|---|---|
| Home | Home |
| Inbox | Inbox, Inbox · Human review, Inbox · Question, Inbox · Blocked |
| Plan | Plan · New session, Plan · Conversation, Plan · Plan v2, Plan · Runner offline |
| Projects | Projects, Project overview, Project settings (Board and Backlog are built, see [board.md](board.md) and [backlog.md](backlog.md)) |
| Task and epic | Task COR-35, Task COR-35 · Activity, Epic · Billing |
| Settings | Settings, Settings · Runner |
| Search | Search |
| Onboarding | Setup · Your name, Setup · Repository, Setup · Agent CLIs, Setup · Name agents |
