# Onboarding

**Canvas frames:** `1 · Your name`, `2 · Choose a repo`, `3 · Detect agents`, `4 · Name agents`
**Route:** `/setup`, one step per query (`/setup?step=repo`). Shown on first run, before the app shell exists. The shell isn't rendered here.

## Purpose

Take a new user from nothing to a working first project in four steps. Setup checks run along the way, so the user never lands on an empty app that can't do anything (PRD §7.1: a project can't start work until setup checks pass).

## Layout

- **Top bar** (64px, bottom border): Corral logo and name on the left, a "Runs locally" neutral badge on the right.
- **Content column:** centred, `max-w-3xl`, 48px top padding.
  1. **Stepper** (`UStepper`, horizontal): You → Repository → Agents → Names. Completed steps show a check and can be clicked to go back. The current step's indicator is filled `primary`. Future steps use `bg-elevated` with `text-muted`. Step descriptions hide below 640px.
  2. **Heading:** `text-2xl` semibold, with a one-line `text-muted` description under it.
  3. **Card** (`UCard`): a body, then a footer with Back (outline neutral) on the left and Continue (solid primary, trailing arrow) on the right.

## Steps

### 1. Your name

- **Field:** Your name (`UFormField` + `UInput` size `lg`, leading user icon), required.
- **Avatar preview:** a `UAvatar` with live initials, plus "How you'll appear on comments, approvals and PM questions".
- **Footer note:** "Saved on this machine only."
- **Validation:** non-empty.

### 2. Choose a repository

- **Repository:** a GitHub repository (`owner/name`), picked from the repos the runner's `gh` login can see, with search. Helper text: "The runner clones it; nothing on your own machine is touched."
  > **Canvas is out of date here.** It shows a local folder path with Browse…. Under D12 the runner lives in a container on the home server, so a browser folder path means nothing to it.
- **Detected repo panel** (`bg-muted`): repo name, remote URL in mono, and a "Repository found" success badge. Below that, two selects (`USelectMenu`):
  - **Default branch:** `main`, `develop`, …
  - **Merge method:** Squash and merge, Merge commit, or Rebase and merge.
- **Setup checks:** a list, each item with an icon, title and detail.
  - ✓ Git repository
  - ✓ GitHub access (gh CLI signed in)
  - ✓ Not claimed by another Corral instance
  - ℹ No `.corral/` yet: it will be added on finish, and existing files are left alone
- **Continue:** disabled until every check passes. Warnings and info items don't block.

### 3. Confirm agent CLIs

- **Card header:** "Detected on your PATH", "1 of 3 supported CLIs found", and a **Scan again** ghost button.
- **One row per supported CLI**, card-style checkboxes:
  - **Claude Code:** the detected path, a **Ready** success badge, "Signed in. Will run your PM, developer and reviewer agents." Checked by default.
  - **Codex CLI, Gemini CLI:** "not found", a **Coming later** neutral badge, disabled.
- **Info alert** (`UAlert`, subtle info, shield icon): "Your credentials stay with your CLI. Corral never sees, stores or sends your model-provider login." (D1–D2)
- **Continue** ("Confirm and continue") needs at least one ready CLI selected.

### 4. Name your agents

- **Card header:** "Agent roles", "All three run on Claude Code for now", and a **Suggest names** ghost button that cycles name sets.
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
- **Server calls:** list repos visible to the runner's `gh`, then setup checks; a scan of the **runner container** for supported CLIs, which also checks whether `claude` is signed in, without reading credentials (D2, D12). If it isn't signed in, show the `docker exec -it … claude` login step.

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
