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
| Repository | A `bg-muted` panel with the branch icon, the GitHub remote in mono, and **Change** | "The runner keeps its own clone; your working copy is never touched." The canvas also shows a local path, which should go (D12) |
| Default branch | `USelectMenu` | "Agents branch from here and merge back into it." |
| Merge method | `USelectMenu`: Squash and merge, Merge commit, Rebase and merge | |
| Required checks | Toggle chips (`aria-pressed`): Lint, Typecheck, Tests, Build | "With no checks, every task needs human review." |

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

- **Project:** name, thumbnail (colour or image), prefix, GitHub remote, default branch, merge method, required checks, paused, human-review default, review-round cap, failed-run cap.
- **Writes:** a single `PATCH` on Save. Pause is its own call.

## States

- **Changing the repository:** reruns the setup checks from onboarding step 2 in a modal.
- **Prefix already used by another project:** shows an inline error.

## Accessibility

- Every control has a label or `aria-labelledby`.
- Switches use `role="switch"` with `aria-checked`.

## Open questions

- Should changing the prefix rename existing task IDs, with redirects from the old ones, or only affect new tasks? The design says new tasks only.
- Should project-level agent overrides exist (for example a different reviewer for one project), or stay strictly global?
