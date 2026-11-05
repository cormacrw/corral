# COR-518 · Guided code review in the Inbox panel

A small model orders a PR's changed hunks into steps that tell the story of the change. Each step has a title, a one- or two-sentence *why* tied to the task's criteria, and its hunks. This design covers how a person reads that guide in the Inbox panel (`InboxPanel*.vue`, `docs/design/inbox.md` Option D) on desktop and on a phone. It doesn't design how the guide is generated.

Prototype: `pnpm --filter web prototype`, then open `prototype-dist/#/inbox/<item>` and choose **Code diff**. Every screen is built from the real panel, tabs, buttons, alerts and badges (shadcn-nuxt, D32).

## Options

### Option A: a **Guide** tab, one step at a time (walkthrough)

A new tab after Code diff: **… · PR description · Code diff N · Guide · Message**. It shows one step at a time: a sticky bar with ← / *Step 2 of 5* / **Next**, the progress segments, the title, the why, then that step's hunks. **Next** marks the step read. A hunk's **In Files** switches to the Code diff tab.

- **For:** the most focus. One step fills the space, which suits a phone. A clear "you are here".
- **Against:** a sixth tab on a tab bar that already scrolls on a phone (Overview · Criteria · Review · PR description · Code diff · Message), and the same hunks live in two tabs. You can't see the whole story at once, so it's hard to skip to the step you care about or see what's left. Going to the raw diff loses your place in the tab you came from.
- In the prototype: add `?option=a` to the item, e.g. `#/inbox/t-cor-60?option=a`, then open **Guide**.

### Option B (recommended): **Guided · Files** inside Code diff, as an outline

Code diff gets a two-way switch at the top: **Guided n/m** and **Files**. Same tab, same hunks, two orders. Guided is an outline of numbered steps, one open at a time. The open step shows its why, the criteria it serves as badges, its hunks, and **Previous** / **Read · next step**. Closed steps show their title and which files they touch, so the whole story is visible at a glance.

- **For:** no new tab. The raw diff is one click away, in the same place, and **In Files** on any hunk opens that file in Files. The outline shows the whole story and what's left, and any step can be opened directly. The progress segments and *n of m read* say where you are. It degrades gracefully: until a guide exists, Code diff opens on Files as today.
- **Against:** an open step in the middle of a list is less immersive than a full-screen step. A long PR makes a long outline, eased by having one step open at a time and by its sticky header.

### Also considered

- **Steps annotating Files** (step chips on each file and hunk): keeps the file order, which breaks the story the guide exists to tell.
- **Side-by-side step list and diff:** doesn't fit the panel's width beside the Inbox list and the docked task flyout, and not at all on a phone.

**Recommendation: Option B.** It answers both "what's the story" and "show me the raw diff" in one tab, doesn't grow the tab bar, and works the same on a phone.

## Screens (Option B unless noted)

Ids are stable for build planning. Each has a desktop (1280 px) and mobile (390 px) screenshot named `<id>-desktop.png` / `<id>-mobile.png`. Mobile captures use the phone layout (`InboxMobile`, D17, forced with the device override `corral.device.layout = mobile`), where the item fills the screen and the actions sit in the bottom bar.

| Id | Item in the prototype | What it shows |
|---|---|---|
| `guide-not-generated` | COR-5 `#/inbox/t-cor-5`, Code diff → Guided | Not generated yet. Code diff opens on **Files**, with *Guided reads it as steps* beside the switch. Guided shows a dashed card: *Read this change as a story*, how many hunks, that it takes seconds and doesn't change the PR, **Generate guide** and *Read the files instead*. |
| `guide-generating` | COR-62 `#/inbox/t-cor-62` | Generating. A spinner line *Generating the guide from N hunks…* with a link to **Files**, and three skeleton steps. Polls every second; the rest of the panel and its actions keep working. Generate on COR-5 goes through this state to ready in about 3 s. |
| `guide-ready` | COR-60 `#/inbox/t-cor-60` | Ready. Code diff opens on **Guided 0/5**. *5 steps · 0 of 5 read · Made 12m ago for 5b030d7*, the progress segments, then the outline with the first unread step open. |
| `guide-progress` | COR-60, after **Read · next step** twice | Read marks: steps 1–2 show a green tick instead of their number and a muted title, the segments for them are green, the open step's segment is primary, *2 of 5 read*, and the switch says **Guided 2/5**. |
| `guide-other-changes` | COR-60, last step | The final **Other changes** step: dashed border, a `…` mark instead of a number, a fixed why (*Hunks the guide didn't place in a step…*), and the hunks no model step covered (an import change and a wiki line). Its button is **Read · done**. |
| `guide-to-files` | COR-60, **In Files** on a hunk | Moving to the raw diff: the switch moves to **Files**, that file opens and scrolls into view with a highlighted border. **Guided** returns to the outline with the same step open and the read marks kept. |
| `guide-truncated` | COR-61 `#/inbox/t-cor-61` | A diff over the cap ("Rename agent roles", 34 files): the same warning as Files (*Showing 4 of 34 files, up to N changed lines* · **See the full diff on GitHub**) above the steps. |
| `guide-truncated-cut` | COR-61, open step 3 *Every screen reads the map* | A step that reaches past the cap: its hunk in a shown file renders as usual, and each hunk in a file past the cap (`TaskCard.vue`, `RunHeader.vue`) shows its path with *Past the diff's cap, so not shown here* · **See it on GitHub**. |
| `guide-error` | COR-63 `#/inbox/t-cor-63` | Error: *Couldn't generate the guide* with the reason and **Retry** (the shared `AppLoadError`). Retry goes to generating, then ready. |
| `guide-single` | COR-64 `#/inbox/t-cor-64` | A single small change: no outline, progress or Other changes. The title, the why, the one hunk and an *I've read this change* checkbox. |
| `option-a-guide-tab` | COR-60 `#/inbox/t-cor-60?option=a`, **Guide** | Option A for comparison: the Guide tab on step 2 after **Next**. |

## Interactions

- **Switch:** **Guided n/m · Files** (`AppTabs`, pill). Code diff opens on Guided when a guide exists or is generating, else on Files. The choice holds while the item is open.
- **Opening a step:** click its header. One step is open at a time; its header (mark and title) sticks just under the switch, so the step's title stays in view while you read its hunks.
- **The switch stays in view:** the **Guided · Files** switch sticks to the top of the panel's scroller, so the raw diff is one tap away from anywhere in a long guide, and after **In Files** you can see you're in Files.
- **Scrolling:** moving to a step or a file scrolls only the panel's own scroller, never the page.
- **Moving between steps:** **Read · next step** marks the open step read, opens the next and scrolls to it. **Previous** opens the one before. Each progress segment jumps to its step. On the last step the button is **Read · done**, which closes it.
- **Read marks:** a step is read once you press **Read · next step** (or **Read · done**) on it. Click the numbered mark to mark a step read or unread without opening it. Read steps show a green tick, a muted title and a green segment; the count shows as *n of m read* and in the switch label. They're kept per browser and per head commit, so a new push starts them over.
- **To the raw diff:** **In Files** on any hunk switches to Files, opens that file and scrolls to it. Back on Guided, nothing is lost.
- **Mobile:** the same panel, with the hunks' lines wrapping (`whitespace-pre-wrap`, `overflow-wrap:anywhere`) instead of scrolling sideways, so neither the hunk nor the page scrolls horizontally. Paths that don't fit truncate from the start, keeping the file name. On desktop lines keep their shape and the hunk box scrolls sideways, as in Files.
- **Generate / Retry:** `POST …/guide`, then poll `GET …/guide` every second while `generating`.

## Components

New, in `apps/web/app/features/inbox/`:

- `components/InboxPanelCodeDiff.vue`: the Code diff tab with the Guided · Files switch (Option B).
- `components/InboxPanelGuide.vue`: every guide state; `layout: 'outline' | 'walkthrough'`.
- `components/InboxGuideHunk.vue`: one hunk with its path, **In Files** and its lines, or the past-the-cap row.
- `components/InboxPanelGuideTab.vue`: Option A's tab (prototype only, `?option=a`).
- `composables/usePullRequestGuide.ts`: the query, generate, polling and read marks (`useLocalStorage`, key `corral:guide-read:<taskRef>:<headSha>`).
- `utils/guide.ts`: splits patches into hunks, resolves steps against the diff and builds **Other changes**.

Changed: `InboxPanelDiff.vue` takes `focus` (open and scroll to a file); `InboxPanelDetails.vue` renders `InboxPanelCodeDiff` for Code diff. Reused: `AppTabs`, `AppButton`, `AppAlert`, `AppLoadError`, `AppBadge`, `AppCheckbox`, `UiSkeleton`, `MarkdownText`.

## Mock data

`PullRequestGuide` in `packages/contracts/src/pull-requests.ts`:

```ts
interface PullRequestGuide {
  status: 'none' | 'generating' | 'ready' | 'failed'
  headSha: string | null      // the head commit it was made for
  steps: { id: string, title: string, why: string, criterionIds: string[], hunks: { path: string, hunk: number }[] }[]
  error: string | null
  generatedAt: string | null
}
```

`hunk` is the position of the `@@` block in the file's patch. The model's steps don't include **Other changes**; the client builds it from the hunks no step covers, so every hunk is shown exactly once. Endpoints (mocked in `prototype/mock-api.ts`): `GET` and `POST /projects/:slug/pull-requests/:number/guide`. Fixtures: COR-60…64 are new review tasks (COR-61's PR has its own role-rename diff, `rolesFiles`, with two step hunks in files past the cap) with PRs #70…74 and realistic diffs (`runLogFiles`, `tooltipFile`), and `guides` holds a guide per PR number; COR-5's PR #64 has none yet.

## Open questions

1. **Where read marks live.** The prototype keeps them in the browser, per head commit. Storing them on the server would follow the reviewer across devices (phone, then desktop). Recommendation: browser first, server only if asked.
2. **A new push.** The guide is for one head commit. Should a later push regenerate automatically, or show *Made for an older commit* with **Regenerate**? Recommendation: the latter, so the model only runs when asked.
3. **When to offer a guide.** A one-hunk PR gets a single step. Should Corral skip the model below a size (say one file, under 20 lines) and show the hunk with the task's goal? Recommendation: keep it on request, as designed, until we see usage.
4. **Read and approval.** Read marks are only for the reader; they don't gate **Approve**. Should approving with unread steps warn? Recommendation: no, keep it informational.
