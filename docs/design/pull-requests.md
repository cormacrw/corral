# Pull requests

`/projects/:slug/pull-requests` (`pages/projects/[slug]/pull-requests.vue`). Reached from **Pull requests** under the project in the sidebar, the command palette, and **PRs** on the mobile project card.

Every task in the project with an open PR, and where it stands against the merge gates (PRD §7.9). The data comes from `GET /projects/:slug/pull-requests`, which reads GitHub live and runs the same gate check as the merge orchestrator, so the page says exactly what a merge attempt would.

## Desktop

- **Toolbar:** "Pull requests", "N open PRs · M eligible to merge · live from GitHub", and a **Refresh** button.
- **Table**, one row per PR, ordered by task number:
  - **Task:** ref, status badge, and title (truncates first when space is short).
  - **PR:** `#number`, linking to GitHub in a new tab.
  - **Review:** the latest verdict: Approved (`success`), Changes requested (`error`) or Not reviewed. A verdict for an older commit is `neutral`, with the commit in its tooltip.
  - **CI:** over the project's required checks: Passing, Failing or Pending, each check's result in the tooltip. "No required checks" when the project has none.
  - **Rebase:** Up to date, Behind base (the base moved on), Updating (Corral asked GitHub to update the branch) or Conflicts (the developer has to rebase).
  - **Evidence:** Complete or Incomplete.
  - **Merge:** **Eligible**; **Waiting for human review** when every gate passes but the human hasn't approved; or, for an ineligible PR, the first gate blocking it in core's order (no approval for the head commit, required checks haven't passed, evidence is incomplete, can't merge into the base branch), with "Also: …" listing any other failed gates.
- Clicking a row (or Enter/Space on it) opens the task flyout; clicking the open row closes it.
- Every state is written out; colour is never the only signal.

## Mobile

One card per PR: ref, PR number and status badge; the title; Review, CI, Rebase and Evidence as label/badge rows; and the merge line under a divider. Tapping a card opens the task page. The shell header reads "Pull requests" under the project name and goes back to the project.

## Live

The page re-reads the list when a task in the project is created, updated or deleted, and every 30 seconds while the tab is visible, because CI results and base-branch moves happen on GitHub without a Corral event.

## Empty and error states

- No open PRs: "No open pull requests. They show here once a developer opens one."
- Loading: skeleton rows. A failed first load shows the error; a failed refresh keeps the last list.
