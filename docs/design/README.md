# Corral UI design

Page-by-page specs for the web app (`apps/web`). The interactive mockups live on the design canvas: <https://claude.ai/artifact/QBjDV6Wyj72DXqKA6RU8AT>. Each spec names its canvas frame.

The mobile PWA design is on its own canvas: <https://claude.ai/artifact/VwiPAt4wMA2v9cCEALMGss>, with an offline export in [mobile-pwa.html](mobile-pwa.html). The mobile shell (layout switch, override and tab bar) is in [mobile.md](mobile.md) (D17); the page specs below still apply to its behaviour.

These specs describe the UI only. Behaviour rules come from [decisions.md](../decisions.md) and [flows.md](../flows.md); where a spec and a decision disagree, the decision wins.

## Pages

| Page | Spec | Route | Scope |
|---|---|---|---|
| Onboarding | [onboarding.md](onboarding.md) | `/setup` | Global, first run |
| App shell (sidebar) | [app-shell.md](app-shell.md) | wraps everything | Global |
| Mobile shell (tab bar) | [mobile.md](mobile.md) | wraps everything on mobile | Global |
| Plan | [plan.md](plan.md) | `/plan`, `/plan/:sessionId` | Global, picks a project |
| Inbox | [inbox.md](inbox.md) | `/inbox`, `/inbox/:itemId` | Global, items tagged by project |
| Task flyout and task page | [task.md](task.md) | `?task=COR-29`, `/tasks/COR-29` | Shared everywhere |
| Epic flyout and epic page | [epic.md](epic.md) | `?epic=<id>`, `/epics/<id>` | Shared everywhere |
| Project overview | [project-overview.md](project-overview.md) | `/projects/:slug` | Per project |
| Board | [board.md](board.md) | `/projects/:slug/board` | Per project |
| Backlog | [backlog.md](backlog.md) | `/projects/:slug/backlog` | Per project |
| Pull requests | [pull-requests.md](pull-requests.md) | `/projects/:slug/pull-requests` | Per project |
| Project settings | [project-settings.md](project-settings.md) | `/projects/:slug/settings` | Per project |
| Agent | [agent.md](agent.md) | `/agents/:name`, `/agents/:name/runs/:runId` | Global |
| Settings | [settings.md](settings.md) | `/settings/:section` | Global |

## Information architecture

- **Global:** Plan, Inbox, Agents, Settings. They work across every project and always show which project a thing belongs to.
- **Per project:** Overview, Board, Backlog, Pull requests, Settings. Reached from the project's entry in the sidebar.
- **Agents are global.** Juno (PM), Atlas (developer), Vera (reviewer) and the designer serve every project (D23). They are configured in Settings, not per project.
- **Planning happens in Plan.** The PM never creates Inbox items of its own; open Plan sessions with a question or a plan needing approval appear in the Inbox as Plan threads, where the question can be answered or the plan approved too (D11, amended).

Multiple projects, global agents and per-project task prefixes are decided in **D13**.

## Shared conventions

### Nuxt UI and tokens

- Use Nuxt UI components and semantic tokens only: `--ui-bg`, `--ui-bg-muted`, `--ui-bg-elevated`, `--ui-bg-accented`, `--ui-text-dimmed|muted|toned|highlighted|inverted`, `--ui-border`, `--ui-border-accented`, and the colour aliases `primary`, `success`, `info`, `warning`, `error`, `neutral`.
- Theme comes from `app.config.ts` (`ui.colors.primary`, `ui.colors.neutral: 'slate'`) and `main.css` (`--font-sans`). Settings can override the neutral palette in dark mode only, saved per device (see [Settings](settings.md#appearance)). Never hard-code hex values in components. The only exception is a project's thumbnail colour, which is user data.
- Light and dark mode both have to work. Primary uses shade 500 in light mode and 400 in dark mode, which is Nuxt UI's default.
- Radii follow Nuxt UI: controls `rounded-md`, cards and panels `rounded-lg`, avatars and dots `rounded-full`.

### Project thumbnails

`ProjectThumbnail` takes a project and a pixel size. It displays the uploaded image as a cropped rounded square, with the project name as alt text, and falls back to the existing colour and initial when absent or unable to load. Use it for project thumbnails in navigation, lists, overview headers, Plan picker options and Inbox project labels. Small contextual colour dots remain dots. The static prototype bundles a Corral image; Marketing site demonstrates the colour fallback.

### Task IDs

Tasks are shown as `PREFIX-NUMBER`, e.g. `COR-29`. Each project sets its own prefix. PRs keep `#41` and runs keep `#128`, so the three never look alike.

### Status colours (D10)

| Status | Colour |
|---|---|
| Backlog | neutral |
| Ready | info |
| In progress, Agent review | primary |
| Human review | warning |
| Ready to merge | success |
| Blocked, Failed | error |
| Merged | success |

A status is always shown with its label. Colour is never the only signal.

### Shared patterns

- **Prompt composer.** Used in Plan, the Inbox tray, the task flyout and live agent runs. It is a rounded `UChatPrompt`-style box: an auto-growing textarea of 2–10 rows, then a toolbar row. The toolbar has an attach button, context-specific tools, the hint "Enter to send · Shift+Enter for new line", and a submit button. The submit is an icon button that is disabled until there's something to send. When an action is selected it becomes a labelled button, e.g. "Approve and merge ↑". Enter sends; Shift+Enter adds a new line. Images can be pasted, dropped or picked with the attach (paperclip) button. Each one uploads straight away and shows as a removable thumbnail, spinning while it uploads and marked if it fails. Send stays disabled until every upload has finished. A message can be just images. On send, `![name](attachment:<id>)` is appended for each image. Files that aren't PNG, JPEG, WebP or GIF, or are over 10 MB, are refused with an error toast.
- **Images in text.** Markdown shows `attachment:<id>` images (and only those) as size-capped thumbnails, and clicking one opens it full size in a lightbox. This covers Plan messages, comments and inbox items.
- **Quick actions.** Chips above the composer that set what Send does. The first action is selected whenever an item opens. Picking another changes the placeholder and submit label; picking the selected chip keeps it selected. Arrow keys select and focus adjacent chips, wrapping at the ends; only the selected chip is in the Tab order. Destructive actions use `error`.
- **Task flyout.** One component, docked on the right of Inbox, Plan, Board, Backlog, Pull requests and Agent pages. See [task.md](task.md).
- **Resizable panes.** Splits that hold lists can be resized with a 1px divider. The divider turns `primary` on hover, focus and drag, and moves 16px per arrow-key press. Use `UDashboardPanel` with `resizable`.
- **Working indicator.** Anything an agent is actively running on (it holds a lease) gets the pulse: the outline breathes in `primary` and the avatar's status dot pings. Respect `prefers-reduced-motion` with a static `primary` outline and no ping. "Working" comes from the lease, not the status (D10).
- **Unread dot.** An 8px `primary` dot. It's used on Inbox rows. Side nav Plan threads use the attention indicators described in [Plan](plan.md#side-nav-threads).

### States every page must handle

Loading (skeletons, never spinners on whole pages), empty, error (a `UAlert` with retry), runner offline (Plan and live runs are unavailable, with a banner explaining why), and project paused (a banner on project pages with Resume).

### Deployment (D12)

The app is served from the home server behind Cloudflare Access, and agents run in the runner container. Never design around the browser's own filesystem: repos are GitHub repositories, and paths and runner names come from configuration. Live connections (SSE, WebSocket) must cope with reconnects.
