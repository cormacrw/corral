# Project settings

**Canvas frames:** `App shell · Project settings`, `Project settings (component)`
**Route:** `/projects/:slug/settings`

## Purpose

Settings that belong to one project: identity, repository and automation. Agents and the runner are global and live in [settings.md](settings.md).

## Layout

The page scrolls, in a column up to 880px wide.

- **Sticky header:** "Project settings", "Settings for {name} only. Agents and the runner are shared by every project and live in Settings.", a "Saved" note, and **Save changes** (solid primary). Save is disabled until something changes or while any field is invalid.
- **Sections:** `UPageCard`-style bordered cards with a title row. Each setting is a two-column row: label and help on the left, the control on the right. Rows stack below 720px.

### General

| Setting | Control | Rules |
|---|---|---|
| Name | `UInput` | Required |
| Thumbnail | A live preview (40px), 8 colour swatches as a `radiogroup` (selected one ringed), and **Upload image** | An image replaces the initial |
| Task ID prefix | `UInput`, mono, max 5 characters, uppercased as you type, letters only | 2–5 letters A–Z. The help reads "Next task: COR-55. Existing tasks keep their IDs." Invalid input gets an `error` ring and "Use 2–5 letters, A–Z." |

### Repository

| Setting | Control | Notes |
|---|---|---|
| Repository | A `bg-muted` panel with the branch icon, `github.com/owner/name` in mono, "Cloned on the runner · fetched 2 minutes ago", and **Change** | **Change** opens the same repo picker as onboarding, inline below the panel, and its label becomes **Done**. The current repo is selected. Repos used by other projects show "Used by {project}" and are disabled; read-only repos are disabled too. Picking a different repo shows a `warning` note: "Saving stops running work on this project, reruns the setup checks against {repo}, and keeps existing tasks. Open PRs on the old repository are left as they are." It only takes effect on Save |
| Default branch | `USelectMenu` | "Agents branch from here and merge back into it." |
| Epic review mode | `USelectMenu`: Epic PR, Each task, Direct | "For new epics a plan doesn't set a mode for", followed by the chosen mode's description. The default for each new epic's review mode (D23); existing epics keep theirs |
| Merge method | `USelectMenu`: Squash and merge, Merge commit, Rebase and merge | |
| Required checks | Toggle chips (`aria-pressed`): Lint, Typecheck, Tests, Build | "With no checks, unflagged tasks merge on the reviewer's approval alone." |

### Automation

| Setting | Control | Notes |
|---|---|---|
| Pause project | `USwitch` | Applies immediately (no Save). Shows the paused banner and the sidebar label. "No new runs start; work already running finishes." |
| Human review for new tasks | `USwitch` | The default for the per-task flag (D5) |
| Limits | Number inputs: Review rounds (default 5), Failed runs (default 3) | Hitting a limit makes the task Blocked or Failed (D10) |

### Danger zone

A card with an `error`-tinted border.

- **Remove project:** the button reads "Remove {name}" in an `error` outline. The help reads "Stops every run and removes the project from Corral. Your repository, branches and PRs on GitHub are left alone."
- It needs a confirmation `UModal` where you type the project name.

## Data

- **Project:** name, thumbnail (colour or image), prefix, GitHub remote, default branch, default epic review mode, merge method, required checks, paused, human-review default, review-round cap, failed-run cap.
- **Writes:** a single `PATCH` on Save for form fields (including the fallback colour). Pause is its own call. Thumbnail upload (`PUT /api/projects/:slug/thumbnail`, multipart `file` field) and removal (`DELETE` at the same path) apply immediately and update the preview and sidebar. Upload accepts PNG, JPEG, WebP and GIF up to 2 MB, shows a spinner over the 40px preview while pending, and reports validation and server errors in a toast without replacing the previous image. **Remove image** appears only when an image is set. Swatches remain usable with an image and change only its fallback colour; the image takes precedence. The prototype keeps these changes in memory until reload.
- **Remove:** `DELETE /api/projects/:slug` with `{ "confirm": "<project name>" }`; anything else is a 400. The server pauses the project, stops its queued and running runs and releases their leases, then deletes the project with its tasks, epics, plans, plan sessions and runs in one transaction. It makes no GitHub call. Clients get a `project.deleted` event. The runner is asked to remove each worked task's worktrees (keeping any with uncommitted changes); it has no hook yet for removing the repository's clone, so that stays on disk.

## States

- **Changing the repository:** on Save, stops runs on this project and reruns the setup checks from onboarding step 2. If a check fails, the old repository stays and the error is shown in the row.
- **Prefix already used by another project:** shows an inline error.

## Accessibility

- Every control has a label or `aria-labelledby`.
- Switches use `role="switch"` with `aria-checked`.

## Open questions

- Should changing the prefix rename existing task IDs, with redirects from the old ones, or only affect new tasks? The design says new tasks only.
- Should project-level agent overrides exist (for example a different reviewer for one project), or stay strictly global?
