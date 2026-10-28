import { richTextToPlainText } from '@corral/core'

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
    section('Task', richTextToPlainText(task.description) || '(no description)'),
    section('Acceptance criteria', task.criteria.map(c => `- [${c.id}] ${c.text}`).join('\n')),
    section('Evidence the developer attached (this round)', evidence),
    task.previousFeedback ? section('Your feedback last round', task.previousFeedback) : '',
    commentsSection(task),
    section('How to review', `
- You are in a read-only checkout of the commit under review. Do not edit, commit or push. Run \`git diff ${task.defaultBranch}...HEAD\` or \`git log\` to see the change; \`origin/${task.defaultBranch}\` is available locally.
- Read \`.corral/CORRAL.md\` and the wiki if they exist, and check the wiki was updated where behaviour changed.
- Judge every acceptance criterion: is it implemented, and does the evidence actually show it? Use \`get_evidence\` to list items and fetch screenshots by ID. Reproduce at least one criterion yourself when you can (run the tests, start the app).
- Check the project's lint, typecheck and tests pass on this commit.
- Call \`report_outcome\` with outcome "approved" or "changes_requested", a \`criteria\` verdict for every criterion ID above (met true/false with a note), and a summary with your reasoning. Feedback must be specific and actionable; it is posted to the developer as a comment.
- Always finish by calling \`report_outcome\`.`)
  ].join('\n')
}

export function developerPrompt(task: PromptTask, agentName: string): string {
  const revision = task.reviewRounds > 0
  return [
    `You are ${agentName}, the developer agent in Corral. You are working on task ${task.ref}: ${task.title}.`,
    revision
      ? `This is a revision: review round ${task.reviewRounds} of ${task.reviewRoundCap} requested changes. Address every piece of feedback below.`
      : 'Implement the task so that every acceptance criterion is met.',
    '',
    section('Task', richTextToPlainText(task.description) || '(no description)'),
    section('Acceptance criteria', task.criteria.map(c => `- [${c.id}] ${c.text}`).join('\n')),
    commentsSection(task),
    section('How to work', `
- You are in a git worktree on branch \`${task.branch}\`, based on \`${task.defaultBranch}\`. Commit your work on this branch.
- Do not push and do not use \`gh\`. Corral pushes the branch and opens the PR when you report your outcome.
- Read \`.corral/CORRAL.md\` and the relevant \`.corral/wiki/\` pages first, if they exist. Update the wiki in the same branch when behaviour changes.
- Run the project's lint, typecheck and tests before reporting.
- Attach evidence for every acceptance criterion with \`attach_evidence\`, using the criterion ID in brackets above: screenshots or videos of the running app for UI work (use a headless browser), real requests and responses for APIs, and test output otherwise.
- Use \`get_task\` to re-read the task, comments and evidence at any time, and \`add_comment\` to leave notes for the human or reviewer.
- When the work is committed and evidenced, call \`report_outcome\` with outcome "${revision ? 'pr_updated' : 'pr_opened'}" and a plain-English summary of what changed and how you verified it. If anything is missing, the call fails and tells you what to fix.
- If you cannot continue without a human decision, call \`report_outcome\` with outcome "stuck" and put the question in the summary.
- Always finish by calling \`report_outcome\`.`)
  ].join('\n')
}
