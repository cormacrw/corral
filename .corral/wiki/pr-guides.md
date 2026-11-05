# PR guides (guided code review, COR-525)

The Inbox panel's Code diff tab has a **Guided · Files** switch
(`InboxPanelCodeDiff.vue`). Guided reads the PR as ordered steps a small model
wrote; Files is the raw diff.

**Generation.** Only on request: `POST /projects/:slug/pull-requests/:number/guide`
claims the `pull_request_guides` row (one per project PR, with the head SHA it's
for) as `generating` and returns at once; a POST while one is generating returns
it instead of starting another. A row stuck generating for over 5 minutes counts
as failed. The server sends a `pr_guide` setup job: the runner runs `claude -p`
with `config.titleModel`, no tools and no MCP, like Plan session titles, so
Corral never handles a model credential (D1, D2, D18). The prompt
(`guidePrompt` in `apps/server/src/pull-request-guides.ts`) carries the task's
title, goal and criteria with their IDs, and each file's hunks numbered from 0
(`splitPatchHunks` in contracts, shared with the web app). It reads up to 100
files and 80k characters of patch; later files go in by name only.

**Validation.** `parseGuide` takes the JSON between the first `{` and last `}`,
drops unknown paths, out-of-range hunks, unknown criterion IDs and any hunk an
earlier step took, then steps left with no hunks. Bad JSON, no steps, a job
failure or no runner online saves the guide as `failed` with a readable `error`.
A new push never regenerates; the panel shows *Made for an older commit* with
**Regenerate**.

**Other changes.** The model may leave hunks out. `guideSteps` in
`apps/web/app/features/inbox/utils/guide.ts` resolves steps against the panel's
capped diff and adds a final **Other changes** step of every uncovered hunk, so
each shown hunk appears exactly once. A step hunk in a file past the cap renders
as *Past the diff's cap* with a GitHub link.

**Read marks.** Browser only, in `useLocalStorage` under
`corral:guide-read:<taskRef>:<PR head sha>`, so a push starts them over. They
are informational and don't gate or warn on Approve.

**Sticky headers.** The switch sticks above the scroller's padding; the open
step's header sticks at `--guide-head-top`, measured from the switch's height,
one pixel under it so no diff line shows through.

**Demo.** `guidedReviews` in `apps/server/src/demo/scenarios.ts` seeds a task per
state; the demo runner answers `pr_guide` after 3 s with `demoGuideAnswer`.
