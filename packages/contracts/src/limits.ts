// Limits the server, the runner and the web app all enforce, so each refuses
// what the others would. Free of zod: the web app imports it through /client.

export const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`

// Images people upload: task text attachments, profile pictures and project
// thumbnails. Never SVG, which can carry script.
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageContentType = typeof IMAGE_CONTENT_TYPES[number]
export const UNSUPPORTED_IMAGE = 'Use a PNG, JPEG, WebP or GIF image'
export const imageTooLarge = (maxBytes: number) => `The image is over ${megabytes(maxBytes)}`

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
// Resized in the browser before upload
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024

// One evidence file, which the runner reads from the agent's disk and the server stores
export const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024
export const EVIDENCE_TOO_LARGE = `Evidence files are limited to ${megabytes(EVIDENCE_MAX_BYTES)}`

// A design version: the packed bundle and its screenshots together (D20)
export const DESIGN_VERSION_MAX_BYTES = 25 * 1024 * 1024
export const DESIGN_TOO_LARGE = `Not submitted. A design version is limited to ${megabytes(DESIGN_VERSION_MAX_BYTES)}.`

// How long the runner waits for the server's answer to an agent's tool call
export const TOOL_CALL_TIMEOUT_MS = 120_000

// The steps of setup jobs on the runner, each with its own limit
export const SETUP_STEP_TIMEOUTS = {
  // `<cli> --version` and its login check, each
  cliDetect: 15_000,
  ghAuth: 15_000,
  ghApi: 60_000,
  ghRepo: 30_000,
  // One clone or fetch of a project's repository
  repoSync: 10 * 60_000,
  // A compare-and-swap push of a shared branch
  casPush: 2 * 60_000,
  // Any command given no limit of its own, such as most git steps
  command: 2 * 60_000
} as const

const step = SETUP_STEP_TIMEOUTS

const MARGIN_MS = 10_000

// Waits for the round trip on top of the runner's time, so the runner's own
// error is the one that reaches people
const paired = (runnerMs: number, marginMs = MARGIN_MS) => ({ runnerMs, waitMs: runnerMs + marginMs })

// A job that is a run of git steps has no limit of its own on the runner, only
// the server's wait, worked out from its steps' limits. A local step that hits
// its limit ends the job, so the local steps count once; the remote ones and
// any cleanup after a failure count in full.
const gitSteps = (runnerMs: number) => ({ waitMs: runnerMs + MARGIN_MS })
// Bringing the bare clone up to date: a clone first, when the runner has none
const sync = 2 * step.repoSync

// Setup jobs: how long the runner may take over each one (`runnerMs`), and how
// long the server waits for the answer (`waitMs`). Every kind needs an entry:
// the server's request reads its wait here.
export const SETUP_JOB_TIMEOUTS = {
  // Every runtime at once, each checked in two steps
  detect_clis: paired(2 * step.cliDetect, 30_000),
  // gh auth status, then gh api
  list_repos: paired(step.ghAuth + step.ghApi),
  // gh auth status, gh api, then a clone and a fetch
  check_repo: paired(step.ghAuth + step.ghRepo + 2 * step.repoSync),
  // A CI log can take two tries, for gh versions that refuse a flag
  github: paired(2 * step.ghApi),
  session_title: paired(30_000),
  inbox_message: paired(30_000),
  // A PR guide reads the whole diff, so it gets longer than a title (COR-525)
  pr_guide: paired(150_000, 20_000),
  release_notes: paired(120_000),
  // Both of the task's worktrees: a status check, the removal and a prune, none of which ends the job
  cleanup_worktrees: gitSteps(2 * 3 * step.command),
  // A first sweep can have a lot to remove, behind fetches holding the repo locks
  sweep_worktrees: { waitMs: 10 * 60_000 },
  // The local steps, then the candidate's push
  integration_prepare: gitSteps(sync + step.command + step.command),
  integration_push: gitSteps(step.command + step.casPush),
  integration_inspect: gitSteps(sync + step.command),
  // The local steps, then removing the throwaway worktree and a prune
  epic_rebase_prepare: gitSteps(sync + step.command + 2 * step.command),
  epic_rebase_push: gitSteps(sync + step.command + step.casPush),
  epic_rebase_inspect: gitSteps(sync + step.command)
} as const
