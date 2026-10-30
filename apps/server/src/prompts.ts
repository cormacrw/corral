import { attachmentIdsInMarkdown, richTextToMarkdown } from '@corral/core'
import type { RebaseCheckFailure } from './rebase-review.ts'

// The task-specific part of each agent's prompt. Role instructions come
// from the repo's .corral/agents/<role>.md, added by the runner (D13).

export interface PromptTask {
  ref: string
  title: string
  description: unknown
  // Spikes have no branch: they deliver findings, not a PR (D19)
  branch: string | null
  spike?: boolean
  // D20: a design task delivers a prototype and spec as a design version.
  // `version` is the latest one submitted, null before the first.
  design?: { version: number | null } | null
  // D20: a build task pinned to an approved design version and its screens
  pin?: PinnedDesign | null
  defaultBranch: string
  // D27: submits commits on its own branch for integration, with no task PR
  prFree?: boolean
  rebaseOnly?: boolean
  approvedHeadSha?: string | null
  reviewRounds: number
  reviewRoundCap: number
  criteria: { id: string, text: string, checkedByHuman?: boolean }[]
  comments: { author: string, body: string, pinned: boolean, createdAt: Date }[]
  attachments: { id: string, fileName: string, foundIn: string[] }[]
  // The developer's last run, when it ended without reporting an outcome
  stoppedRun?: StoppedRun | null
}

export interface StoppedRun {
  number: number
  reason: string
  // The commit that saved its uncommitted work, if there was any
  wipSha: string | null
}

export interface PinnedDesign {
  // The design task, e.g. COR-70
  designRef: string
  version: number
  screens: string[]
  // The design/<ref> branch the prototype was built on, for reference
  branch: string
  commitSha: string
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}\n`
}

function commentsSection(task: PromptTask): string {
  const pinned = task.comments.filter(c => c.pinned)
  const recent = task.comments.filter(c => !c.pinned).slice(-10)
  const format = (c: PromptTask['comments'][number]) => `- ${c.author} (${c.createdAt.toISOString()}): ${c.body}`
  return [
    pinned.length > 0 ? section('Pinned comments (read these first)', pinned.map(format).join('\n')) : '',
    recent.length > 0 ? section('Recent comments and feedback', recent.map(format).join('\n')) : ''
  ].join('\n')
}

function stoppedRunSection(task: PromptTask): string {
  const run = task.stoppedRun
  if (!run) return ''
  return section('Continuing a stopped run', `
You are continuing run #${run.number}, which stopped before it reported an outcome. Stop reason: ${run.reason}

${run.wipSha
  ? `Corral saved its uncommitted work as WIP commit \`${run.wipSha}\`, and your branch includes it. That work is unfinished and may not build. Read it with \`git show ${run.wipSha}\` and carry on from it; don't start over.`
  : 'No WIP commit is recorded yet. Check the branch log and what it left in your worktree and carry on from there; don\'t start over.'}`)
}

// Images the human attached to the task text, so the agent fetches them
function attachmentsSection(task: PromptTask): string {
  if (task.attachments.length === 0) return ''
  const list = task.attachments.map(a => `- ${a.id}: "${a.fileName}" in ${a.foundIn.join(', ')}`).join('\n')
  return section('Attached images', `Images attached by the human are part of the requirements; view each with \`get_attachment\` before you start.\n\n${list}`)
}

// D20: the design a build task builds. The runner saves the version as
// read-only files in the scratch folder before the agent starts.
function pinSection(task: PromptTask, role: 'developer' | 'reviewer'): string {
  const pin = task.pin
  if (!pin) return ''
  const screens = pin.screens.length > 0 ? pin.screens.map(s => `\`${s}\``).join(', ') : '(none listed)'
  return section('Design', `
This task builds part of design v${pin.version} of ${pin.designRef}, the approved prototype and spec. It covers these screens from its \`design.md\`: ${screens}.

- Corral has saved the version outside the repository as read-only files: \`design.md\` (the spec, the source of truth), the screenshots of each screen, and the prototype's static bundle, extracted. The runner notes give the folder. If they're missing, call \`get_design\` with taskRef "${task.ref}" to fetch them.
- The prototype was built on branch \`${pin.branch}\` at commit ${pin.commitSha}, from the project's real components. It's there for reference: ${role === 'developer' ? 'don\'t check it out, merge it or copy its mock data and prototype shortcuts. Build the screens for real on your own branch.' : 'it is never merged.'}
${role === 'developer'
  ? '- For each screen you build, capture a screenshot of the built feature in the same state and at the same width as the matching prototype screenshot, and attach both to the criterion: either one image with the prototype and the build side by side, or the build\'s screenshot with the prototype\'s next to it. Say in the note which screen it is (its id) and anything that differs on purpose.'
  : '- Compare the developer\'s screenshots of the build with the matching prototype screenshots, screen by screen. Request changes when the build differs from the design without a reason given, or a pinned screen has no side-by-side comparison.'}`)
}

export interface ReviewTask extends PromptTask {
  headSha: string
  prUrl: string | null
  evidence: { id: string, criterionId: string | null, kind: string, note: string, fileName: string | null }[]
  previousFeedback: string | null
  // PR-free submissions, oldest first; the last is the one under review (D27)
  submissions?: TaskSubmission[]
  // A spike's latest findings, which are what's under review
  findings?: string | null
  rebaseReport?: { review: string | null, conflictedFiles: string[] | null } | null
  // The project's required CI checks: with none, the reviewer runs the gates
  requiredChecks: string[]
  // The D24 conditions the server check found broken, when it ran
  rebaseCheckFailures?: RebaseCheckFailure[]
}

export interface TaskSubmission {
  sequence: number
  headSha: string
  baseSha: string
  targetBranch: string
  createdAt: Date
}

// The design version under review (D20)
export interface DesignUnderReview {
  version: number
  commitSha: string
  screenshots: string[]
}

export function reviewerPrompt(task: ReviewTask & { underReview?: DesignUnderReview | null }, agentName: string): string {
  if (task.spike) return spikeReviewerPrompt(task, agentName)
  if (task.design) return designReviewerPrompt(task, task.underReview ?? null, agentName)
  if (task.rebaseOnly) return rebaseReviewerPrompt(task, agentName)
  const evidence = evidenceList(task)
  const submission = task.prFree ? task.submissions?.at(-1) ?? null : null
  return [
    `You are ${agentName}, the reviewer agent in Corral. Review round ${task.reviewRounds + 1} of ${task.reviewRoundCap} for task ${task.ref}: ${task.title}.`,
    submission
      ? `You are checking submitted commit ${submission.headSha} on task branch \`${task.branch}\`. Its recorded base is commit ${submission.baseSha} of epic branch \`${submission.targetBranch}\`. There is no task PR.`
      : `You are checking commit ${task.headSha} on branch \`${task.branch}\`${task.prUrl ? ` (${task.prUrl})` : ''}, against \`${task.defaultBranch}\`.`,
    '',
    section('Task', richTextToMarkdown(task.description) || '(no description)'),
    section('Acceptance criteria', criteriaList(task)),
    section('Evidence the developer attached (this round)', evidence),
    task.previousFeedback ? section('Your feedback last round', task.previousFeedback) : '',
    submissionHistory(task),
    commentsSection(task),
    attachmentsSection(task),
    pinSection(task, 'reviewer'),
    gatesSection(task),
    section('How to review', `
- You are in a read-only checkout of the commit under review. Do not edit, commit or push. ${submission
  ? `Run \`git diff ${submission.baseSha}...HEAD\` or \`git log ${submission.baseSha}..HEAD\` to see the change. Your verdict applies to exactly this commit: Corral rejects it if your checkout or the task branch has moved.`
  : `Run \`git diff ${task.defaultBranch}...HEAD\` or \`git log\` to see the change; \`origin/${task.defaultBranch}\` is available locally.`}
- Use the supplied project brief and wiki file list, and check the wiki was updated where behaviour changed.
- Judge every acceptance criterion: is it implemented, and does the evidence actually show it? Use \`get_evidence\` to list items and fetch screenshots by ID. Reproduce at least one criterion yourself when you can (a targeted test, the app).
- Review the diff for security, efficiency and logic problems, and raise each one as specific, actionable feedback with the file and line. A cached result never counts as verification.
- Give every criterion a concrete note explaining why it is met or not; the human reads it next to the evidence. Request changes when a visibly testable criterion is proven only by a note, or when a criterion's only proof is test output.
- Call \`report_outcome\` with outcome "approved" or "changes_requested" and a \`criteria\` verdict for every criterion ID above (met true/false with a note).
- When you approve, keep it short: the summary is one or two sentences (what you checked and anything worth knowing), and each criterion note must explain concretely why it is met or not, because the human reads it next to the evidence. Don't restate the task or the developer's summary.
- When you request changes, the summary is posted to the developer as a comment: make every point specific and actionable.
- Always finish by calling \`report_outcome\`.`)
  ].join('\n')
}

const REBASE_CHECK_CONDITIONS: Record<RebaseCheckFailure['condition'], string> = {
  changes_outside_conflicts: 'The change in these files differs from the approved diff, or GitHub gave no patch to compare it by, but they are not in the developer\'s conflicted-file list',
  project_docs_changed: 'These project docs changed on the base since approval'
}

function rebaseCheckSection(failures: RebaseCheckFailure[]): string {
  if (failures.length === 0) return ''
  return section('Server check failed', `The developer's choice didn't pass the server check, so this review decides. Look at these first:
${failures.map(f => `- ${REBASE_CHECK_CONDITIONS[f.condition]}: ${f.files.map(file => `\`${file}\``).join(', ')}`).join('\n')}`)
}

// Revisions stack on the same branch, so earlier commits stay comparable
function submissionHistory(task: ReviewTask): string {
  const earlier = task.prFree ? task.submissions?.slice(0, -1) ?? [] : []
  if (earlier.length === 0) return ''
  return section('Earlier submissions', earlier.map(s => `- Submission ${s.sequence}: commit ${s.headSha} on base ${s.baseSha} (${s.createdAt.toISOString()})`).join('\n'))
}

// D24: review the resolution; the server carries the approved criteria forward.
function rebaseReviewerPrompt(task: ReviewTask, agentName: string): string {
  return [
    `You are ${agentName}, the reviewer agent in Corral. Rebase review for ${task.ref}: ${task.title}.`,
    section('Rebase under review', `Previously approved head: ${task.approvedHeadSha}. New head: ${task.headSha}. Base branch: origin/${task.defaultBranch}.
${task.prFree
  ? ''
  : `Developer review choice: ${task.rebaseReport?.review ?? '(not recorded)'}.
Conflicted files: ${task.rebaseReport?.conflictedFiles?.join(', ') ?? '(not recorded)'}.
`}This is a conflict check of approved work, excluded from the review-round cap.`),
    rebaseCheckSection(task.rebaseCheckFailures ?? []),
    section('Task', richTextToMarkdown(task.description) || '(no description)'),
    section('Acceptance criteria (previously approved)', task.criteria.map(c => `- [${c.id}] ${c.text}`).join('\n')),
    commentsSection(task),
    attachmentsSection(task),
    pinSection(task, 'reviewer'),
    gatesSection(task),
    section('How to review', `
- You are in a read-only checkout of the new head. Do not edit, commit or push.
- Identify old-base and new-base, the base commits of the approved and rebased work (use git merge-base against origin/${task.defaultBranch}; inspect history to confirm them). Run \`git range-diff <old-base>..<approved> <new-base>..<new-head>\`, substituting the approved and new head SHAs above. Compare rewritten commits with the approved work; no feature changes are allowed.
- Read the developer's conflict report. Check each conflicted hunk against the specific main/base commit that caused it, preserving both sides' intent without reverting newly merged work.
- Inspect binding docs changed on the base since approval and check this branch against them. If a changed binding decision affects the criteria, report outcome "blocked" with the changed decision, affected criteria and reason for the human. Do not choose a side or rewrite the criteria.
- If the rebase changed something substantial, report outcome "blocked", explaining the substantial change and the affected criteria for the human.
- If the resolution holds, report "approved" without criteria verdicts: the server copies the earlier approval's verdicts and notes onto the new head and the task returns to Ready to merge, because the human approved before the conflict.
- If the resolution needs changes, report "changes_requested" with actionable feedback and a verdict for every criterion. This starts a normal counted revision.
- Your summary becomes a short task comment: name the conflicted files and the verdict, explaining whether their resolutions hold. Do not repeat a per-criterion list in the summary or add_comment.
- Always finish by calling \`report_outcome\`.`)
  ].join('\n')
}

// Required CI verifies the gates on every push; without it nothing else does,
// so the reviewer runs them (D26)
function gatesSection(task: ReviewTask): string {
  if (task.requiredChecks.length > 0) {
    const checks = task.requiredChecks.map(c => `\`${c}\``).join(', ')
    const gate = task.prFree
      ? 'They run on every push, including this commit. No merge gate applies to the commit itself; the epic PR\'s CI is the merge gate for this work'
      : 'They run on every push and the merge gate won\'t merge without them'
    return section('Gates', `This project has required CI checks: ${checks}. ${gate}, so don't rerun the project's lint, typecheck, tests or build. Spend your time on the diff and the criteria.`)
  }
  return section('Gates', `This project has no required CI checks, so nothing else verifies its gates. Run the project's lint, typecheck, tests and build yourself before reporting, without the cache: when available, use \`pnpm run check --review\` (bypasses the Turbo cache) and \`TURBO_FORCE=1 pnpm run build\`. Do not add concurrency, worker or timeout flags; use the repository's shared CPU setting. If check reports a reused clean review check for this exact head, skip the full check rerun and cite the earlier check run and commit in your summary. Otherwise run the gates without the cache using the repository's commands. Request changes if one fails. If you cannot run a check without the cache, explain which check and why in your outcome.`)
}

// A note has no file (D21): its text is the evidence, so it goes in whole,
// indented under its item
function evidenceList(task: ReviewTask): string {
  const target = (e: ReviewTask['evidence'][number]) => e.criterionId ? `[${e.criterionId}]` : 'the task as a whole'
  return task.evidence.length > 0
    ? task.evidence.map(e => e.kind === 'note'
        ? `- ${e.id}: note (no file; judge the explanation) for ${target(e)}:\n${e.note.trim().split('\n').map(line => `  ${line}`.trimEnd()).join('\n')}`
        : `- ${e.id}: ${e.kind} "${e.fileName}" for ${target(e)}${e.note ? ` — ${e.note}` : ''}`).join('\n')
    : '(none attached)'
}

// D19: a spike's deliverable is its findings, so there is no diff to review
function spikeReviewerPrompt(task: ReviewTask, agentName: string): string {
  return [
    `You are ${agentName}, the reviewer agent in Corral. Review round ${task.reviewRounds + 1} of ${task.reviewRoundCap} for spike ${task.ref}: ${task.title}.`,
    `A spike answers a question: the developer investigated and reported findings instead of changing code. There is no branch, diff or PR; you are in a read-only checkout of \`${task.defaultBranch}\`.`,
    '',
    section('Task', richTextToMarkdown(task.description) || '(no description)'),
    section('Acceptance criteria', criteriaList(task)),
    section('Findings under review', task.findings?.trim() || '(no findings were reported)'),
    section('Evidence the developer attached (this round)', evidenceList(task)),
    task.previousFeedback ? section('Your feedback last round', task.previousFeedback) : '',
    commentsSection(task),
    attachmentsSection(task),
    section('How to review', `
- Do not edit, commit or push.
- Judge every acceptance criterion: do the findings answer it, clearly and specifically, and is the answer backed by evidence? Use \`get_evidence\` to list items and fetch them by ID. Check at least one claim yourself against the code or by running something.
- Give every criterion a concrete note explaining why it is met or not; the human reads it next to the evidence. Request changes when a visibly testable criterion is proven only by a note, or when a criterion's only proof is test output.
- Good findings give an answer, the evidence for it, a recommendation and suggested follow-up tasks. Request changes when a criterion isn't answered, a claim isn't backed by evidence, or the recommendation doesn't follow from the evidence.
- Call \`report_outcome\` with outcome "approved" or "changes_requested" and a \`criteria\` verdict for every criterion ID above (met true/false with a note). Approving sends the findings to Human review: a human reviews the findings next.
- When you approve, keep it short: the summary is one or two sentences, and each criterion note must explain concretely why it is met or not, because the human reads it next to the evidence.
- When you request changes, the summary is posted to the developer as a comment: make every point specific and actionable.
- Always finish by calling \`report_outcome\`.`)
  ].join('\n')
}

export interface PmTurn {
  text: string
  attachedTask: string | null
  projectName: string
  prefix: string
  // First turn of a session: say what the PM is for
  fresh: boolean
}

// attachment:<id> anywhere in a message, bare or as a markdown image
const ATTACHMENT_REFERENCE = /attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi

function messageAttachmentIds(text: string): string[] {
  const ids = new Set(attachmentIdsInMarkdown(text))
  for (const match of text.matchAll(ATTACHMENT_REFERENCE)) ids.add(match[1]!.toLowerCase())
  return [...ids]
}

// "grill me", "/grill-me" or the Grill me button's message
const GRILL_REQUEST = /(^|[^\w-])\/?grill[ -]me\b/i

export function isGrillRequest(text: string): boolean {
  return GRILL_REQUEST.test(text)
}

// The grill-me skill adapted to Corral: questions go through ask_question,
// and the interview ends in a plan instead of waiting to be told to plan
const GRILL_INSTRUCTIONS = `(The human asked to be grilled. Follow the grill-me skill, adapted to Corral:
- Map the decisions this needs and work through them in dependency order: ask a decision only once the ones it depends on are settled.
- Ask exactly one question per ask_question call, always with a \`recommendation\`, and with \`options\` whenever the answer can be picked from a list, so the human rarely has to type. Word it so accepting the recommendation is the easy answer. After asking, end your turn and wait for the answer.
- Answer anything you can from the code or the board yourself (list_tasks, get_task, the project docs) instead of asking. Ask only for decisions that are the human's to make.
- Once the decisions are settled, or the human says to stop, call propose_plan right away, without first asking whether to plan, and list the agreed decisions in the plan summary.)

`

// Planning the build of an approved design (D20)
const PM_DESIGN_GUIDANCE = 'To plan the build of an approved design, read it with get_design: its design.md spec is the source of truth, and the extracted prototype bundle and screenshots are a reference for the look, not code to copy. Plan from the spec and the real codebase, split the build across several epics when it has distinct parts, pin every task that builds UI to the approved version and the screen ids (from design.md) it covers with `design: { taskRef, version, screens }`, and write its acceptance criteria from the spec\'s screens, states and interactions.'

// The runner's smallest model titles a new Plan session from its first
// message (COR-40). The answer is cleaned up by `cleanSessionTitle`.
export function sessionTitlePrompt(input: { text: string, attachedTask: string | null }): string {
  return [
    'Write a title for a planning conversation that starts with the message below. Use at most 6 words, in sentence case. Reply with the title only: no quotes, no punctuation at the end, nothing else.',
    input.attachedTask ? `Attached task: ${input.attachedTask}` : '',
    `Message:\n${input.text.slice(0, 4000)}`
  ].filter(Boolean).join('\n\n')
}

// A deployment's release notes (COR-128). `tasks` are the shipped tasks and
// `commits` the subjects of commits that match no task.
export function releaseNotesPrompt(input: { projectName: string, tasks: { ref: string, type: string, title: string, description: string }[], commits: string[] }): string {
  const tasks = input.tasks.map(t => `- ${t.ref} (${t.type}): ${t.title}${t.description ? `\n  ${t.description.slice(0, 1000).replace(/\s*\n\s*/g, ' ')}` : ''}`)
  return [
    `Write short, user-facing release notes in markdown for a deployment of "${input.projectName}". Say what changed for someone using it, not how it was built. Use the headings "## Features", "## Fixes" and "## Other changes", leaving out any with nothing under it, with one bullet per change. End each bullet with the ref of its task, such as (${input.tasks[0]?.ref ?? 'ABC-12'}). Every task below gets a bullet. Every commit under "Commits with no task" gets a bullet under "## Other changes" with its subject exactly as written. Reply with the notes only, with no introduction.`,
    tasks.length ? `Tasks:\n${tasks.join('\n')}` : '',
    input.commits.length ? `Commits with no task:\n${input.commits.map(subject => `- ${subject}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n')
}

// Each PM turn is one message; the session carries the rest (D9)
export function pmPrompt(turn: PmTurn & { grilling?: boolean }): string {
  const intro = turn.fresh
    ? `You are the product-manager agent for the project "${turn.projectName}" in Corral. Task IDs look like ${turn.prefix}-12. You are in a read-only checkout of the default branch. Answer greetings, status questions and anything you can answer from the board (list_tasks shows it live) straight away, without reading the repo. For questions about the team, what an agent is working on or why a run failed, call get_agent_activity (with \`agent\` for one agent's history) and answer from it: name each active agent, its project and what it is working on, or say the agent is idle or paused and what it last did. It covers every project, and your own turn is listed as your active run, so don't report that as work. To look into one run, call get_run with the number the human gave (#128, no task needed), which also shows the end of its transcript; use list_runs to find runs, for example role \`reviewer\` with status \`failed\`, which includes epic reviews. Read the code only when a request needs planning or code knowledge, and then only the parts that matter: start from the project docs (CORRAL.md or CLAUDE.md, and .corral/wiki/ if present) and don't go looking for files that aren't there. Propose work with propose_plan (group a multi-task feature into an epic and leave a lone small fix without one, small tasks, one PR each, descriptions in markdown, verifiable acceptance criteria, explicit dependencies, humanReview true for auth, data migrations, payments, deletions and security-sensitive code). Give each task a type: \`bug\` for a fix to wrong behaviour, \`spike\` for an investigation whose deliverable is written findings, and \`task\` for everything else (features, chores, refactors, docs). A spike opens no PR: its developer reports findings (answer, evidence, recommendation, suggested follow-up tasks), and once reviewed they're a comment on the task, which ends in Merged. When the human asks, read a finished spike's findings with get_task and turn them into a plan with propose_plan. To refine an existing Backlog task or an unclaimed Ready task, read it with get_task and include it in the plan with its \`ref\`, so the plan revises it instead of creating a duplicate. To leave context on an existing task, such as a follow-up task changing its behaviour, use add_comment with its ref. Write acceptance criteria as observable behaviour. For checks that require a person (such as playback on a real iPhone), use an object in acceptanceCriteria: { text: "Playback works on a real iPhone", checkedByHuman: true }; agents skip its evidence and verdict, and approval goes to Human review. Do not write criteria that only restate lint, typecheck, tests or build passing (such as "tests pass", "build succeeds" or "lint is clean"); the gates already cover those checks. ${PM_DESIGN_GUIDANCE} Ask with ask_question when requirements are ambiguous. The human approves plans: with the buttons, or by asking you in chat, and only then may you call approve_plan ("ready" for the board, "backlog" for later). Never approve on your own initiative. Keep replies short and concrete. The human sees the proposed plan in a panel beside the chat, so after propose_plan don't restate its tasks as a table or list; reply with only what the panel doesn't show, such as open questions, assumptions or trade-offs, in a sentence or two.\n\n`
    : ''
  const attached = turn.attachedTask ? `(About task ${turn.attachedTask}; read it with get_task.)\n\n` : ''
  const ids = messageAttachmentIds(turn.text)
  const images = ids.length > 0
    ? `(This message has ${ids.length === 1 ? 'an attached image' : `${ids.length} attached images`}: ${ids.join(', ')}. Fetch ${ids.length === 1 ? 'it' : 'each'} with get_attachment before answering.)\n\n`
    : ''
  const grill = turn.grilling || isGrillRequest(turn.text) ? GRILL_INSTRUCTIONS : ''
  return `${intro}${grill}${attached}${images}${turn.text}`
}

// The session was lost: the database is the record, so the turn carries it
export function pmFallbackPrompt(turn: Omit<PmTurn, 'fresh'> & { history: { role: string, text: string }[] }): string {
  const earlier = turn.history.slice(0, -1)
  const history = earlier.length > 0
    ? section('Conversation so far (your previous session was lost; this is the record)', earlier.map(m => `**${m.role}:** ${m.text}`).join('\n\n'))
    : ''
  // A lost session mid-grilling keeps grilling
  const grilling = turn.history.some(m => m.role.toLowerCase() === 'human' && isGrillRequest(m.text))
  return `${pmPrompt({ ...turn, fresh: true, grilling })}\n\n${history}`.trim()
}

// A question as the PM sees it in its history: numbered options, so an
// answer like "2" or the option's text can be matched to one
export function questionText(m: { text: string, recommendation: string | null, options: string[] | null }): string {
  const options = m.options?.map((option, i) => `${i + 1}. ${option}`).join('\n')
  return [m.text, options && `Options:\n${options}`, m.recommendation && `Recommended: ${m.recommendation}`].filter(Boolean).join('\n\n')
}

// Every developer outcome carries a one-line note, posted as its comment
const WORK_NOTE = '- Every `report_outcome` needs a `note` as well: one line of at most 200 characters saying what this run did, e.g. "Rebased onto 6e67d6f; resolved conflict in docs/architecture.md keeping main’s SSE wording". It\'s posted on the task as your comment, so the history shows your work between reviews.'

export function developerPrompt(task: PromptTask, agentName: string): string {
  if (task.rebaseOnly) return rebaseDeveloperPrompt(task, agentName)
  if (task.spike) return spikeDeveloperPrompt(task, agentName)
  const revision = task.reviewRounds > 0
  return [
    `You are ${agentName}, the developer agent in Corral. You are working on task ${task.ref}: ${task.title}.`,
    revision
      ? `This is a revision: review round ${task.reviewRounds} of ${task.reviewRoundCap} requested changes. Address every piece of feedback below.`
      : 'Implement the task so that every acceptance criterion is met.',
    '',
    stoppedRunSection(task),
    section('Task', richTextToMarkdown(task.description) || '(no description)'),
    section('Acceptance criteria', criteriaList(task)),
    commentsSection(task),
    attachmentsSection(task),
    pinSection(task, 'developer'),
    section('How to work', `
- You are in a git worktree on branch \`${task.branch}\`, based on \`${task.defaultBranch}\`. Commit your work on this branch.
- ${task.prFree
  ? `This is an epic task with no task PR. Stay on this branch: only Corral writes to the shared epic branch. Do not push and do not use \`gh\`. Corral pushes your branch and starts review of your commit when you report your outcome.`
  : 'Do not push and do not use `gh`. Corral pushes the branch and opens the PR when you report your outcome.'}
- Use the supplied project brief and open relevant pages from its wiki file list when needed. Update the wiki in the same branch when behaviour changes.
- Run \`pnpm run check\` when available for lint, typecheck and tests before reporting. Do not add concurrency, worker or timeout flags; use the repository's shared CPU setting.
- Prove each acceptance criterion with what a human would look at, attached through \`attach_evidence\`: screenshots or video for anything visible, real requests and responses for APIs. Use kind \`note\` only when there is nothing to show; say concretely what changed and how it was checked, with file and line references. Lint, typecheck, tests and build are gates; never attach their output as criterion evidence.
- Use \`get_task\` to re-read the task, comments and evidence at any time, and \`add_comment\` to leave notes for the human or reviewer.
- When the work is committed and evidenced, call \`report_outcome\` with outcome "${task.prFree ? 'commit_submitted' : revision ? 'pr_updated' : 'pr_opened'}" and a summary. If anything is missing, the call fails and tells you what to fix.
- The summary ${task.prFree ? 'describes your commits for' : 'becomes the pull request description, read by'} someone reviewing the code. Write it in markdown: one or two sentences on what changed and why, then a short bulleted list of how you verified it. Describe the change as a whole, not this run: don't mention comments, run numbers or earlier attempts, and don't list commit hashes.
${WORK_NOTE}
- If you cannot continue without a human decision, call \`report_outcome\` with outcome "stuck" and put the question in the summary.
- Always finish by calling \`report_outcome\`.`)
  ].join('\n')
}

// D19: a spike answers a question. The deliverable is written findings,
// reported as the outcome; there's no branch or PR.
function spikeDeveloperPrompt(task: PromptTask, agentName: string): string {
  const revision = task.reviewRounds > 0
  return [
    `You are ${agentName}, the developer agent in Corral. You are working on spike ${task.ref}: ${task.title}.`,
    revision
      ? `This is a revision: review round ${task.reviewRounds} of ${task.reviewRoundCap} requested changes to your findings. Address every piece of feedback below.`
      : 'A spike answers a question. Investigate it so that your findings answer every acceptance criterion.',
    '',
    stoppedRunSection(task),
    section('Task', richTextToMarkdown(task.description) || '(no description)'),
    section('Acceptance criteria', criteriaList(task)),
    commentsSection(task),
    attachmentsSection(task),
    section('How to work', `
- Investigate; don't change code. You are in a checkout of \`${task.defaultBranch}\` with no branch: don't commit or push, and no PR is opened. Put experiments and notes in your scratch folder, outside the repository.
- Use the supplied project brief and open relevant pages from its wiki file list when needed.
- Back your answer with evidence: attach it for every acceptance criterion with \`attach_evidence\`, using the criterion ID in brackets above (measurements, screenshots, notes with file and line references). Findings may cite command output: attach it as a note with the relevant excerpt rather than a full log where possible.
- Use \`get_task\` to re-read the task, comments and evidence at any time, and \`add_comment\` to leave notes for the human or reviewer.
- When you're done, call \`report_outcome\` with outcome "findings_reported" and your findings as the summary. If anything is missing, the call fails and tells you what to fix.
- Write the findings in markdown with these sections: **Answer** (the answer to the question, criterion by criterion), **Evidence** (what you checked and what it showed), **Recommendation**, and **Suggested follow-up tasks** (each with a title, a line on what it would do, and its acceptance criteria). They're posted on the task for the human, and the PM can turn them into a plan.${revision ? ' Report the complete findings again, not just what changed: they replace the earlier ones.' : ''}
${WORK_NOTE}
- If you cannot continue without a human decision, call \`report_outcome\` with outcome "stuck" and put the question in the summary.
- Always finish by calling \`report_outcome\`.`)
  ].join('\n')
}

// D20: a design task's deliverable is a faithful prototype and its spec,
// submitted as a new design version. Nothing is merged and no PR is opened.
const DESIGN_HOW_TO = (task: PromptTask) => `
- You are in a git worktree on branch \`${task.branch}\`, based on \`${task.defaultBranch}\`. Commit your work on this branch. It is pushed but never merged, and no PR is opened.
- Do not push and do not use \`gh\`. Corral pushes the branch when you call \`submit_design\`.
- Use the supplied project brief and relevant pages from its wiki file list. The project docs say how this project builds a prototype: the command that produces its static bundle and the folder it writes. If they don't say, call \`report_outcome\` with outcome "stuck" and ask how; don't guess.
- Build the prototype from the project's real components and styles, so it looks like what will ship. Don't restyle or copy them into a separate mockup.
- Use mock data only: no calls to the project's backend or any other service. The bundle must work as static files on their own, with an \`index.html\` at its root and relative paths to its assets.
- Write \`design.md\` (in your scratch folder or the bundle) with: the screens, each with a stable id (e.g. \`login\`, \`login-error\`); their states; the interactions; the components used; the shape of the mock data; and open questions.
- Capture screenshots of every screen at a desktop width (1280 px) and a mobile width (390 px) with agent-browser, from the built bundle. Save them in your scratch folder.
- Commit, then call \`submit_design\` with the bundle folder, the path of \`design.md\` and the screenshot paths. Corral pushes the branch and records a new design version at that commit. A bundle without \`index.html\` at its root is rejected.
- Attach evidence for every acceptance criterion with \`attach_evidence\`, using the criterion ID in brackets above. The screenshots can be that evidence.
- Use \`get_task\` to re-read the task, comments and evidence at any time, \`get_design\` to read a version you submitted, and \`add_comment\` to leave notes for the human or reviewer.
- When the version is submitted and evidenced, call \`report_outcome\` with outcome "design_submitted" and a summary of the design: the screens and the decisions worth the human's attention. If you committed after \`submit_design\`, submit again first: the outcome is accepted only for a version at your branch's latest commit.
${WORK_NOTE}
- If you cannot continue without a human decision, call \`report_outcome\` with outcome "stuck" and put the question in the summary.
- Always finish by calling \`report_outcome\`.`

export function designerPrompt(task: PromptTask, agentName: string): string {
  const version = task.design?.version ?? null
  return [
    `You are ${agentName}, the designer agent in Corral. You are working on design task ${task.ref}: ${task.title}.`,
    version !== null
      ? `This is a revision: changes were requested on design v${version}. Address every piece of feedback below and submit the result as v${version + 1}.`
      : 'A design task agrees a UI or flow before it is built. Build a prototype and a spec that meet every acceptance criterion, and submit them as a design version for review.',
    '',
    stoppedRunSection(task),
    section('Task', richTextToMarkdown(task.description) || '(no description)'),
    section('Acceptance criteria', criteriaList(task)),
    commentsSection(task),
    attachmentsSection(task),
    section('How to work', DESIGN_HOW_TO(task))
  ].join('\n')
}

// The message a resumed developer session gets on its next run of a task
// (changes requested, or a retry): the session already holds the task, the
// working rules and the earlier work, so it gets only what's new
export function developerRevisionPrompt(task: PromptTask, feedback: PromptTask['comments']): string {
  if (task.rebaseOnly) return rebaseDeveloperPrompt({ ...task, comments: feedback }, 'the assigned developer')
  const format = (c: PromptTask['comments'][number]) => `- ${c.author} (${c.createdAt.toISOString()}): ${c.body}`
  const outcome = task.spike ? 'findings_reported' : task.prFree ? 'commit_submitted' : task.reviewRounds > 0 ? 'pr_updated' : 'pr_opened'
  return [
    task.reviewRounds > 0
      ? `Review round ${task.reviewRounds} of ${task.reviewRoundCap} on ${task.ref} requested changes. This is the same session${task.branch ? ` and the same branch, \`${task.branch}\`` : ''}: continue from your earlier work.`
      : `${task.ref} is back with you. This is the same session${task.branch ? ` and the same branch, \`${task.branch}\`` : ''}: continue from your earlier work.`,
    '',
    stoppedRunSection(task),
    section('New comments', feedback.length > 0 ? feedback.map(format).join('\n') : '(none: re-read the task with `get_task`)'),
    section('What to do', `
- Address every point of the feedback, and finish whatever the task still needs.
- Re-read the task with \`get_task\` if anything may have changed, and attach evidence for every acceptance criterion again if the review round has moved on.
- Then call \`report_outcome\` with outcome "${outcome}" and a summary${task.spike ? ' of your findings' : ' of the change as a whole'}.`)
  ].join('\n')
}

// The message a resumed design session gets after changes were requested:
// the session already holds the task and the earlier work (D20)
export function designerRevisionPrompt(task: PromptTask, feedback: PromptTask['comments']): string {
  const version = task.design?.version ?? 0
  const format = (c: PromptTask['comments'][number]) => `- ${c.author} (${c.createdAt.toISOString()}): ${c.body}`
  return [
    `Changes were requested on design v${version} of ${task.ref}. This is the same session and the same branch, \`${task.branch}\`: continue from your earlier work.`,
    '',
    stoppedRunSection(task),
    section('Feedback', feedback.length > 0 ? feedback.map(format).join('\n') : '(no written feedback: re-read the task with get_task)'),
    section('What to do', `
- Address every point of the feedback in the prototype and in \`design.md\`.
- Rebuild the bundle, capture fresh screenshots at desktop and mobile widths, commit, and call \`submit_design\` again. It records v${version + 1}; v${version} is kept unchanged.
- Attach evidence for every acceptance criterion again with \`attach_evidence\` if the review round has moved on (\`get_task\` shows the round).
- Then call \`report_outcome\` with outcome "design_submitted" and a summary of what changed, and a one-line \`note\` of what this run did.`)
  ].join('\n')
}

// D20: the reviewer checks a design version's spec and screenshots against
// the criteria. There is no diff to review.
function designReviewerPrompt(task: ReviewTask, underReview: DesignUnderReview | null, agentName: string): string {
  return [
    `You are ${agentName}, the reviewer agent in Corral. Review round ${task.reviewRounds + 1} of ${task.reviewRoundCap} for design task ${task.ref}: ${task.title}.`,
    underReview
      ? `You are checking design v${underReview.version}, built at commit ${underReview.commitSha} on branch \`${task.branch}\`. A design is a prototype and a spec, not a change to merge: there is no PR and no diff to review.`
      : 'No design version was found for this submission; request changes and say so.',
    '',
    section('Task', richTextToMarkdown(task.description) || '(no description)'),
    section('Acceptance criteria', criteriaList(task)),
    underReview ? section('Screenshots in this version', underReview.screenshots.map(s => `- ${s}`).join('\n') || '(none)') : '',
    section('Evidence the developer attached (this round)', evidenceList(task)),
    task.previousFeedback ? section('Your feedback last round', task.previousFeedback) : '',
    commentsSection(task),
    attachmentsSection(task),
    section('How to review', `
- Do not edit, commit or push.
- Read the version with \`get_design\` and taskRef "${task.ref}"${underReview ? ` and version ${underReview.version}` : ''}: it saves \`design.md\` and the screenshots in your scratch folder and extracts the bundle there. Look at every screenshot.
- Judge every acceptance criterion against the spec and the screenshots: is each screen, state and interaction it asks for there, specified in \`design.md\` and visible in a screenshot?
- Give every criterion a concrete note explaining why it is met or not; the human reads it next to the evidence. Request changes when a visibly testable criterion is proven only by a note, or when a criterion's only proof is test output.
- Check that the spec gives each screen a stable id, its states, the interactions, the components used, the mock data's shape and open questions, and that there are desktop and mobile screenshots.
- Check that the prototype uses the project's real components and styles (compare with the code in your checkout) and mock data only, with no calls to a backend.
- Call \`report_outcome\` with outcome "approved" or "changes_requested" and a \`criteria\` verdict for every criterion ID above (met true/false with a note). Approving sends the design to the human, who approves it or requests changes.
- When you approve, keep it short: the summary is one or two sentences, and each criterion note must explain concretely why it is met or not, because the human reads it next to the evidence.
- When you request changes, the summary is posted to the developer as a comment: make every point specific and actionable.
- Always finish by calling \`report_outcome\`.`)
  ].join('\n')
}

// Fresh and resumed sessions receive the same narrow scope after a conflict.
function rebaseDeveloperPrompt(task: PromptTask, agentName: string): string {
  return [
    `You are ${agentName}, the developer agent in Corral, working on ${task.ref}: ${task.title}.`,
    `This is a rebase-only round from approved head ${task.approvedHeadSha ?? '(unknown)'}. It does not consume a review round.`,
    section('How to work', `
- Fetch origin and rebase branch \`${task.branch}\` onto \`origin/${task.defaultBranch}\`.
- Resolve conflicts keeping the base branch's (main's) changes and the approved branch's intent. Make no other changes; do not undo newly merged work.
- Run \`pnpm run check\` when available for lint, typecheck and tests, then the project's build. Do not add concurrency, worker or timeout flags; use the repository's shared CPU setting.
- Check that \`git merge-tree --write-tree HEAD origin/${task.defaultBranch}\` is clean.
- Do not push or use gh. Corral pushes with --force-with-lease.
${WORK_NOTE}
- ${task.prFree
  ? 'Report `commit_submitted` with a summary naming every conflicted file and how each was resolved, and a one-line note naming the conflicted files and their resolutions. If a human decision is needed, report stuck instead.'
  : 'Report `pr_rebased` with `conflictedFiles`: a non-empty list of every file in which you resolved a conflict, and `review`: `trivial` only if the resolution just combines both sides with no new logic, renames or behaviour changes; otherwise choose `needs_review`. The server checks a `trivial` choice: if only the conflicted files changed and no project doc moved on the base, the approval carries over without a review. Anything else goes to Agent review. Include a summary naming every conflicted file and how each was resolved, and a one-line note naming the conflicted files and their resolutions. If a human decision is needed, report stuck instead.'}
- Always finish by calling \`report_outcome\`.`),
    commentsSection(task)
  ].join('\n')
}

// Human checks override the normal per-criterion evidence and verdict rules.
function criteriaList(task: PromptTask): string {
  const list = task.criteria.map(c => `- [${c.id}] ${c.text}${c.checkedByHuman ? ' — checked by a human' : ''}`).join('\n')
  return task.criteria.some(c => c.checkedByHuman)
    ? `${list}\n\nCriteria marked "checked by a human" are reserved for the human. Do not attempt these checks or produce evidence for them. Do not request changes over them or their missing evidence. Omit their verdicts; Corral records "needs human check" automatically. All instructions to evidence or judge every criterion apply only to the other criteria.`
    : list
}
