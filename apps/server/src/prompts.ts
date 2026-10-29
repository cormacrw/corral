import { attachmentIdsInMarkdown, richTextToMarkdown } from '@corral/core'

// The task-specific part of each agent's prompt. Role instructions come
// from the repo's .corral/agents/<role>.md, added by the runner (D13).

export interface PromptTask {
  ref: string
  title: string
  description: unknown
  branch: string
  defaultBranch: string
  reviewRounds: number
  reviewRoundCap: number
  criteria: { id: string, text: string }[]
  comments: { author: string, body: string, pinned: boolean, createdAt: Date }[]
  attachments: { id: string, fileName: string, foundIn: string[] }[]
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

// Images the human attached to the task text, so the agent fetches them
function attachmentsSection(task: PromptTask): string {
  if (task.attachments.length === 0) return ''
  const list = task.attachments.map(a => `- ${a.id}: "${a.fileName}" in ${a.foundIn.join(', ')}`).join('\n')
  return section('Attached images', `Images attached by the human are part of the requirements; view each with \`get_attachment\` before you start.\n\n${list}`)
}

export interface ReviewTask extends PromptTask {
  headSha: string
  prUrl: string | null
  evidence: { id: string, criterionId: string | null, kind: string, note: string, fileName: string }[]
  previousFeedback: string | null
}

export function reviewerPrompt(task: ReviewTask, agentName: string): string {
  const evidence = task.evidence.length > 0
    ? task.evidence.map(e => `- ${e.id}: ${e.kind} "${e.fileName}" for ${e.criterionId ? `[${e.criterionId}]` : 'the task as a whole'}${e.note ? ` — ${e.note}` : ''}`).join('\n')
    : '(none attached)'
  return [
    `You are ${agentName}, the reviewer agent in Corral. Review round ${task.reviewRounds + 1} of ${task.reviewRoundCap} for task ${task.ref}: ${task.title}.`,
    `You are checking commit ${task.headSha} on branch \`${task.branch}\`${task.prUrl ? ` (${task.prUrl})` : ''}, against \`${task.defaultBranch}\`.`,
    '',
    section('Task', richTextToMarkdown(task.description) || '(no description)'),
    section('Acceptance criteria', task.criteria.map(c => `- [${c.id}] ${c.text}`).join('\n')),
    section('Evidence the developer attached (this round)', evidence),
    task.previousFeedback ? section('Your feedback last round', task.previousFeedback) : '',
    commentsSection(task),
    attachmentsSection(task),
    section('How to review', `
- You are in a read-only checkout of the commit under review. Do not edit, commit or push. Run \`git diff ${task.defaultBranch}...HEAD\` or \`git log\` to see the change; \`origin/${task.defaultBranch}\` is available locally.
- Read \`.corral/CORRAL.md\` and the wiki if they exist, and check the wiki was updated where behaviour changed.
- Judge every acceptance criterion: is it implemented, and does the evidence actually show it? Use \`get_evidence\` to list items and fetch screenshots by ID. Reproduce at least one criterion yourself when you can (run the tests, start the app).
- Check the project's lint, typecheck and tests pass on this commit.
- Call \`report_outcome\` with outcome "approved" or "changes_requested" and a \`criteria\` verdict for every criterion ID above (met true/false with a note).
- When you approve, keep it short: the summary is one or two sentences (what you checked and anything worth knowing), and each criterion note is a few words. Don't restate the task or the developer's summary.
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

// Each PM turn is one message; the session carries the rest (D9)
export function pmPrompt(turn: PmTurn & { grilling?: boolean }): string {
  const intro = turn.fresh
    ? `You are the product-manager agent for the project "${turn.projectName}" in Corral. Task IDs look like ${turn.prefix}-12. You are in a read-only checkout of the default branch. Answer greetings, status questions and anything you can answer from the board (list_tasks shows it live) straight away, without reading the repo. Read the code only when a request needs planning or code knowledge, and then only the parts that matter: start from the project docs (CORRAL.md or CLAUDE.md, and .corral/wiki/ if present) and don't go looking for files that aren't there. Propose work with propose_plan (one epic per separate feature, small tasks, one PR each, descriptions in markdown, verifiable acceptance criteria, explicit dependencies, humanReview true for auth, data migrations, payments, deletions and security-sensitive code). To refine an existing Backlog task, read it with get_task and include it in the plan with its \`ref\`, so the plan revises it instead of creating a duplicate. Ask with ask_question when requirements are ambiguous. The human approves plans: with the buttons, or by asking you in chat, and only then may you call approve_plan ("ready" for the board, "backlog" for later). Never approve on your own initiative. Keep replies short and concrete.\n\n`
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

export function developerPrompt(task: PromptTask, agentName: string): string {
  const revision = task.reviewRounds > 0
  return [
    `You are ${agentName}, the developer agent in Corral. You are working on task ${task.ref}: ${task.title}.`,
    revision
      ? `This is a revision: review round ${task.reviewRounds} of ${task.reviewRoundCap} requested changes. Address every piece of feedback below.`
      : 'Implement the task so that every acceptance criterion is met.',
    '',
    section('Task', richTextToMarkdown(task.description) || '(no description)'),
    section('Acceptance criteria', task.criteria.map(c => `- [${c.id}] ${c.text}`).join('\n')),
    commentsSection(task),
    attachmentsSection(task),
    section('How to work', `
- You are in a git worktree on branch \`${task.branch}\`, based on \`${task.defaultBranch}\`. Commit your work on this branch.
- Do not push and do not use \`gh\`. Corral pushes the branch and opens the PR when you report your outcome.
- Read \`.corral/CORRAL.md\` and the relevant \`.corral/wiki/\` pages first, if they exist. Update the wiki in the same branch when behaviour changes.
- Run the project's lint, typecheck and tests before reporting.
- Attach evidence for every acceptance criterion with \`attach_evidence\`, using the criterion ID in brackets above: screenshots or videos of the running app for UI work (use a headless browser), real requests and responses for APIs, and test output otherwise.
- Use \`get_task\` to re-read the task, comments and evidence at any time, and \`add_comment\` to leave notes for the human or reviewer.
- When the work is committed and evidenced, call \`report_outcome\` with outcome "${revision ? 'pr_updated' : 'pr_opened'}" and a summary. If anything is missing, the call fails and tells you what to fix.
- The summary becomes the pull request description, read by someone reviewing the code. Write it in markdown: one or two sentences on what changed and why, then a short bulleted list of how you verified it. Describe the change as a whole, not this run: don't mention comments, run numbers or earlier attempts, and don't list commit hashes.
- If you cannot continue without a human decision, call \`report_outcome\` with outcome "stuck" and put the question in the summary.
- Always finish by calling \`report_outcome\`.`)
  ].join('\n')
}
