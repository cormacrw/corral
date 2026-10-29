# Onboarding

**Canvas frames:** `1 · Your name`, `2 · Choose a repo`, `3 · Detect agents`, `4 · Name agents`
**Mobile:** `SetupMobile.vue`, see [mobile.md](mobile.md#setup)
**Route:** `/setup`, one step per query (`/setup?step=repo`). Shown on first run, before the app shell exists. The shell isn't rendered here.

Onboarding is done once the server has a project, on every browser and device; nothing in the browser (localStorage, cookies) decides it. With no projects, every page leads here. With one, `/` and any `/setup` visit go to the first project, except the add-project flow (`/setup?step=repo&add=1`). If the project list can't be fetched, nothing redirects (`middleware/setup.global.ts`, `utils/onboarding.ts`).

## Purpose

Take a new user from nothing to a working first project in four steps. Setup checks run along the way, so the user never lands on an empty app that can't do anything (PRD §7.1: a project can't start work until setup checks pass).

## Layout

- **Top bar** (64px, bottom border): Corral logo and name on the left, a "Self-hosted" neutral badge on the right.
- **Content column:** centred, `max-w-3xl`, 48px top padding.
  1. **Stepper** (`UStepper`, horizontal): You → Repository → Agents → Names. Completed steps show a check and can be clicked to go back. The current step's indicator is filled `primary`. Future steps use `bg-elevated` with `text-muted`. Step descriptions hide below 640px.
  2. **Heading:** `text-2xl` semibold, with a one-line `text-muted` description under it.
  3. **Card** (`UCard`): a body, then a footer with Back (outline neutral) on the left and Continue (solid primary, trailing arrow) on the right.

## Steps

### 1. Your name

- **Field:** Your name (`UFormField` + `UInput` size `lg`, leading user icon), required.
- **Avatar preview:** a `UAvatar` with live initials, plus "How you'll appear on comments, approvals and PM questions".
- **Saves:** the name goes to the server (`PATCH /api/me`, trimmed, 1–80 characters) when you continue, so any browser or device sees it.
- **Validation:** non-empty.

### 2. Choose a repository

- **Repository picker:** a GitHub repository chosen from the list the runner returns (`list_repos`; see architecture.md). Nothing is typed as a path; under D12 the runner lives in a container, so a browser folder path means nothing to it.
  - **Label row:** "Repository *" with "Repositories the runner's GitHub login can see, most recently updated first", and a **Refresh** ghost button (the list is cached on the server for a few minutes).
  - **Search:** a field at the top of a bordered list, with the placeholder "Search N repositories".
  - **Rows** (`role="option"`): a lock icon (private) or book icon (public); `owner/` muted and `name` bold; a Private/Public badge; the description; and, on the right, "Updated 2h ago" and the default branch in mono. The selected row has a `primary` tint, a `primary` ring and a trailing check.
  - **Rows you can't pick** are shown at 60% opacity, disabled, with the reason under the description:
    - read-only access: "Read-only access: agents couldn't push branches or open PRs"
    - already used by another project (D13): "Used by {project}"
  - **Fallback:** a "Can't find it? Paste a GitHub URL" link reveals a URL input and **Check access**, for repos the list doesn't show (for example an org that hasn't granted the `gh` app access).
- **After a repo is picked**, two selects (`USelectMenu`):
  - **Default branch:** prefilled from GitHub's `defaultBranchRef`. "From GitHub. Agents branch from it and merge back into it."
  - **Merge method:** Squash and merge, Merge commit, or Rebase and merge.
- **Setup checks for {owner/name}:** a list, each item with an icon, title and detail.
  - ✓ Runner can push: the login has write, maintain or admin access
  - ✓ Not used by another project, and not claimed by another Corral instance
  - ✓ Cloned on the runner: the default branch is fetched into the runner's data volume
  - ℹ No `.corral/` yet: it will be added on finish, and existing files are left alone
- **Runner not signed in to GitHub:** the picker is replaced by a `warning` `UAlert`, "The runner isn't signed in to GitHub", with the command `docker exec -it corral-runner gh auth login` in a code block and **Check again**. Corral never sees the token. The canvas `github` tweak shows this state.
- **Continue:** disabled until a repo is picked and every check passes. Info items don't block.

### 3. Confirm agent CLIs

- **Card header:** "Detected on your PATH", "1 of 3 supported CLIs found", and a **Scan again** ghost button.
- **One row per supported CLI**, card-style checkboxes:
  - **Claude Code:** the detected path, a **Ready** success badge, "Signed in. Will run your PM, developer and reviewer agents." Checked by default.
  - **Codex CLI:** the same row as Claude Code when detected and signed in (D18); when it isn't signed in, show the `docker exec -it … codex login --device-auth` step.
  - **Gemini CLI:** "not found", a **Coming later** neutral badge, disabled.
- **Info alert** (`UAlert`, subtle info, shield icon): "Your credentials stay with your CLI. Corral never sees, stores or sends your model-provider login." (D1–D2)
- **Continue** ("Confirm and continue") needs at least one ready CLI selected.

### 4. Name your agents

- **Card header:** "Agent roles", "Each runs on one of the CLIs you selected" with a runtime picker per role (D18), and a **Suggest names** ghost button that cycles name sets.
- **One row per role** (PM, Developer, Reviewer), each with:
  - an avatar with initials
  - the name and a role badge (`primary` subtle)
  - a one-line description of the role
  - a **Name** input
  - a **Runs on** select, offering only the CLIs confirmed in step 3
- **Defaults:** Juno, Atlas and Vera.
- **Finish setup** (solid primary, check icon): creates the project, writes `.corral/` and opens the project overview.

## Data

- **Writes:** user profile (name); first project (name taken from the repo, GitHub remote, default branch, merge method, task prefix); agents (name, role, runtime).
- **Server calls:** `list_repos` on the runner (cached), then setup checks for the chosen repo; a scan of the **runner container** for supported CLIs, which also checks whether `claude` and `codex` are signed in, without reading credentials (D2, D12). If one isn't signed in, show its `docker exec -it …` login step.

## States

- **Runner can't access the repo:** the check shows an error and how to grant `gh` access.
- **A check fails:** the check shows an error icon and a fix-it hint, and Continue is disabled.
- **No supported CLI found:** step 3 shows install guidance and Continue is disabled.

## Accessibility

- Every input has a visible `<label>`.
- Stepper items are links with their step names as accessible names.
- Check results use an icon plus text, never colour alone.

## Open questions

- Does the project's task ID prefix get set here (defaulting to the first three letters of the repo) or only in project settings? Today it defaults silently, and project settings can change it.
- Agent setup moved to global Settings. Should step 4 stay, or should onboarding create default agents and point to Settings?
