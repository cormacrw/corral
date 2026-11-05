# Corral UI design

Page-by-page specs for the web app (`apps/web`). The interactive mockups live on the design canvas: <https://claude.ai/artifact/QBjDV6Wyj72DXqKA6RU8AT>. Each spec names its canvas frame.

The mobile PWA design is on its own canvas: <https://claude.ai/artifact/VwiPAt4wMA2v9cCEALMGss>, with an offline export in [mobile-pwa.html](mobile-pwa.html). The mobile shell (layout switch, override and tab bar) is in [mobile.md](mobile.md) (D17); the page specs below still apply to its behaviour.

These specs describe the UI only. Behaviour rules come from [decisions.md](../decisions.md) and [flows.md](../flows.md); where a spec and a decision disagree, the decision wins.

## Pages

| Page | Spec | Route | Scope |
|---|---|---|---|
| Onboarding | [onboarding.md](onboarding.md) | `/setup` | Global, first run |
| Home | [home.md](home.md) | `/home` | Global, every project |
| App shell (sidebar) | [app-shell.md](app-shell.md) | wraps everything | Global |
| Mobile shell (tab bar) | [mobile.md](mobile.md) | wraps everything on mobile | Global |
| Plan | [plan.md](plan.md) | `/plan`, `/plan/:sessionId` | Global, picks a project |
| Inbox | [inbox.md](inbox.md) | `/inbox`, `/inbox/:itemId` | Global, items tagged by project |
| Task flyout and task page | [task.md](task.md) | `?task=COR-29`, `/tasks/COR-29` | Shared everywhere |
| Parent flyout and parent page | [parent-task.md](parent-task.md) | `?parent=<id>`, `/epics/<id>` | Shared everywhere |
| Project overview | [project-overview.md](project-overview.md) | `/projects/:slug` | Per project |
| Board | [board.md](board.md) | `/projects/:slug/board` | Per project |
| Backlog | [backlog.md](backlog.md) | `/projects/:slug/backlog` | Per project |
| Pull requests | [pull-requests.md](pull-requests.md) | `/projects/:slug/pull-requests` | Per project |
| Project settings | [project-settings.md](project-settings.md) | `/projects/:slug/settings` | Per project |
| Agents and Agent | [agent.md](agent.md) | `/agents`, `/agents/:name`, `/agents/:name/runs/:runId` | Global |
| Settings | [settings.md](settings.md) | `/settings/:section` | Global |

## Information architecture

- **Global:** Home, Plan, Inbox, Agents, Settings. They work across every project and always show which project a thing belongs to.
- **Per project:** Overview, Board, Backlog, Pull requests, Settings. Reached from the project's entry in the sidebar.
- **Agents are global.** Juno (PM), Atlas (developer), Vera (reviewer) and the designer serve every project (D23). They are configured in Settings, not per project.
- **Planning happens in Plan.** The PM never creates Inbox items of its own; open Plan sessions with a question or a plan needing approval appear in the Inbox as Plan threads, where the question can be answered or the plan approved too (D11, amended).

Multiple projects, global agents and per-project task prefixes are decided in **D13**.

## Shared conventions

### Components and tokens

- Use shadcn-vue components through the `App*` composites (D32), and semantic tokens only: `background`, `foreground`, `card`, `popover`, `muted`, `muted-foreground`, `accent`, `border`, `input`, `ring`, `primary`, `destructive`, and Corral's `brand` (primary as text), `success`, `warning` and `info`. Colour props use the tones `primary`, `neutral`, `success`, `warning`, `info` and `error`.
- The theme is shadcn preset `a31Y6GXo` (`reka-vega`, neutral base, emerald primary, Geist, Hugeicons), in `assets/css/theme.css`. Settings can override the neutral palette in dark mode only, saved per device (see [Settings](settings.md#appearance)). Never hard-code hex values.
- Light and dark mode both have to work. Solid fills use `bg-primary`; coloured text uses `text-brand`, because the dark primary fill is too dark to read as text.
- Radii come from the preset's `--radius`: controls `rounded-md`, cards and panels `rounded-lg`, avatars and dots `rounded-full`.

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
| Complete | success |

A status is always shown with its label. Colour is never the only signal.

### Shared patterns

- **Prompt composer.** Used in Plan, the Inbox panel, the task flyout and live agent runs. It is a rounded `UChatPrompt`-style box: an auto-growing textarea of 2–10 rows, then a toolbar row. The toolbar has an attach button, context-specific tools, an optional host hint saying what sending does (no keyboard hints), and a submit button. The submit is a fully rounded icon button that is disabled until there's something to send. When an action is selected it becomes a labelled button, e.g. "Approve and merge ↑". Enter sends; Shift+Enter adds a new line. On the mobile layout Return adds a new line and the submit button sends. An unsent draft and its uploaded images stay in this browser tab through leaving the page or a layout swap; switching Inbox items or tasks still clears it. Images can be pasted, dropped or picked with the attach (paperclip) button. Each one uploads straight away and shows as a removable thumbnail, spinning while it uploads and marked if it fails. Send stays disabled until every upload has finished. A message can be just images. On send, `![name](attachment:<id>)` is appended for each image. Files that aren't PNG, JPEG, WebP or GIF, or are over 10 MB, are refused with an error toast.
- **Images in text.** Markdown shows `attachment:<id>` images (and only those) as size-capped thumbnails, and clicking one opens it full size in a lightbox. This covers Plan messages, comments and inbox items.
- **Inbox actions.** Buttons on a task item, a bar of large targets on a phone, with nothing selected when an item opens (a phone opens a question with Answer chosen). What can go at once is sent in one click; what needs words, or can't be undone, takes over the composer, changing its placeholder and submit label until it's sent or cancelled. Destructive actions use `error`. See [inbox.md](inbox.md#2-selected-message).
- **Task flyout.** One component, docked on the right of Inbox, Plan, Board, Backlog, Pull requests and Agent pages. See [task.md](task.md).
- **Resizable panes.** Splits that hold lists can be resized with a 1px divider. The divider turns `primary` on hover, focus and drag, and moves 16px per arrow-key press. Use the Resizable component.
- **Working indicator.** Anything an agent is actively running on (it holds a lease) gets the pulse: the outline breathes in `primary` and the avatar's status dot pings. Respect `prefers-reduced-motion` with a static `primary` outline and no ping. "Working" comes from the lease, not the status (D10).
- **Unread dot.** An 8px `primary` dot. It's used on Inbox rows. Side nav Plan threads use the attention indicators described in [Plan](plan.md#side-nav-threads).

### States every page must handle

Loading (skeletons, never spinners on whole pages), empty, error (a `AppAlert` with retry), runner offline (Plan and live runs are unavailable, with a banner explaining why), and project paused (a banner on project pages with Resume).

### Deployment (D12)

The app is served from the home server behind Cloudflare Access, and agents run in the runner container. Never design around the browser's own filesystem: repos are GitHub repositories, and paths and runner names come from configuration. Live connections (SSE, WebSocket) must cope with reconnects.
