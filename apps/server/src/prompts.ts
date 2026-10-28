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
