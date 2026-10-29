# App shell

**Canvas frames:** `App shell · Corral overview` plus every `App shell · …` frame
**Component:** `UDashboardGroup` + `UDashboardSidebar` (collapsible, resizable off) + `UDashboardPanel` for the page.

## Purpose

Persistent navigation around every page except onboarding. It separates **global** areas (Plan, Inbox, Agents, Settings) from **projects**, and shows at a glance what needs you and which agents are working.

## Layout

There is no top header on desktop; every page owns the full height. Below 1024px a 48px bar appears with a menu button and the page title, and the sidebar opens as an overlay with a backdrop.

### Sidebar (256px expanded, 72px collapsed), top to bottom

1. **Brand:** the Corral logo (28px `primary` square with the fence icon) and "Corral". There is no project picker.
2. **Search:** an outline button showing "Search…" and the `⌘` `K` keys (`UKbd`). Opens the command palette (`UCommandPalette`).
3. **Global nav** (`UNavigationMenu`, vertical):
   - **Plan:** chat icon and a count badge of open threads needing attention. Open sessions appear as indented sub-items with their project dot, title and attention indicator; see [Plan](plan.md#side-nav-threads).
   - **Inbox:** inbox icon and a count badge (solid primary) of open "Needs you" items across all projects.
4. **Projects:**
   - Section header "Projects" with a **+** ghost icon button, "Add project", which opens the add-project flow (repo picker, as in onboarding step 2).
   - One entry per project:
     - a 20px thumbnail with the project's colour and initial (or an uploaded image)
     - the name, with "Paused" in `warning` when the project is paused
     - a chevron button that expands or collapses it
   - Clicking the name opens the **project overview**.
   - Expanded entries show sub-items, indented with a left guide line:
     - **Board** (with its task count)
     - **Backlog** (with its count)
     - **Pull requests**
     - **Settings**
   - The expanded or collapsed state of each project is remembered per user.
5. **Agents:** Juno · PM, Atlas · Developer and Vera · Reviewer.
   - Each has an avatar with a status dot: `success` with the ping animation when working, `text-dimmed` when idle.
   - Each shows a status label on the right only for Working, Paused or Waiting on usage limit, from the shared `agentStatus` helper. Idle agents, including those with expired usage cooldowns, have no marker.
   - Clicking one opens that agent's page.
6. **Settings:** pinned to the bottom of the scroll area. Global settings.

### Sidebar footer

- **Runner card** (`bg-elevated`): server icon, "Runner online", "{runner name} · {signed-in runtimes}" (e.g. "home-server · Claude Code, Codex"; the canvas says "This Mac") and a status dot (`success`, `warning` while reconnecting, `error` when offline).
- **User row:** avatar and name (not a menu), a colour-mode button (`UColorModeButton`) and a collapse button (`UDashboardSidebarCollapse`).

### Active state

The active item has `bg-elevated` and `text-primary`, with its icon in `primary`. When a project page is active, its project row gets `text-highlighted` and the matching sub-item gets the active style.

### Collapsed (72px)

- Icons, project thumbnails and agent avatars only, with tooltips for names.
- Project sub-items are hidden.
- The footer stacks vertically.

## Banners

**Updating (D16):** while either update-hold phase is active, show an info banner: "Corral is updating. Running work will finish first; new runs start once the update is done. You can keep chatting in Plan." Plan messages and question replies remain enabled: turns start during draining and queue during finishing.

**Project paused:** a full-width `warning` bar above the shell, shown only on that project's pages. It reads "{Project} is paused. No new runs will start; work already running will finish." and has a **Resume** button. Pausing happens in project settings.

## Data

- **Projects:** id, name, slug, prefix, thumbnail (colour or image), paused, board count, backlog count.
- **Inbox:** open count.
- **Plan:** open threads and attention count.
- **Agents:** name, role, working (from active leases).
- **Runner:** status.

Everything stays live over the existing SSE connection.

## Accessibility

- Navigation landmarks: `nav[aria-label="Global"]` and a `group` per project.
- `aria-current="page"` on the active item.
- The expand chevron uses `aria-expanded` and its label reads "Expand Corral" or "Collapse Corral".
- Status dots are decorative; the status text carries the meaning.

## Theme

Primary colour and font come from `app.config.ts` and `main.css`. The design canvas exposes them as Tweaks: the 17 Nuxt UI primary colours, and a set of Google fonts with Public Sans as the default.

## Open questions

- Should a project's sub-items include Overview explicitly, or does clicking the name stay the only way in?
- Should the command palette search tasks across all projects, or default to the current project?

## Scrolling

The document (`html` and `body`) disables overscroll bounce in all layouts, including setup’s bare layout. Scrollable dashboard bodies, board columns, task panels, chat and log panes contain scroll chaining. The mobile layout’s scrolling main area and its page panels also contain chaining, keeping the header and tab bar stationary while content scrolls normally.

Horizontal-only scrollers (Markdown code and tables, command snippets, chip rows and the board lane) contain only horizontal chaining, allowing vertical wheel input to reach their surrounding pane. The mobile main area retains containment on both axes because it also hosts vertical page scrolling.
