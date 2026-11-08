import { CORRAL_MCP_SERVER, DEFAULT_ROLE_INSTRUCTIONS, isGlobalPmJob, toolName, toolsForJob, type RunExit, type RunJob } from '@corral/contracts'
import { isAuthoringRole } from '@corral/core'
import { join } from 'node:path'
import type { SavedDesign } from './designs.ts'
import { readProjectBrief, readRoleInstructions } from './project-docs.ts'

// The text the runner itself gives an agent: its system prompt, and the
// prompt that resumes an agent that ended without reporting.

interface ProjectText {
  instructions: string
  brief: string | null
}

// The role instructions and project brief from the checkout. A global PM
// session has none, so it gets the built-in instructions and no brief.
export async function readProjectText(job: RunJob, worktree: string): Promise<ProjectText> {
  if (isGlobalPmJob(job)) return { instructions: DEFAULT_ROLE_INSTRUCTIONS.pm, brief: null }
  return { instructions: await readRoleInstructions(worktree, job.role), brief: await readProjectBrief(worktree) }
}

export function systemPrompt({ instructions, brief }: ProjectText, job: RunJob, scratchDir: string, design: string | null): string {
  return `${instructions}\n\n${brief ? `${brief}\n\n` : ''}${runnerNotes(job, scratchDir, design)}`
}

// PRD §8.6: an agent that exits without an outcome gets one chance to report
export const RESUME_TO_REPORT_PROMPT = `Your session ended without calling ${toolName('report_outcome')}, and any background commands stopped with it. Check the state of your work. If your outcome depends on a command that did not finish, run it again in the foreground and wait for it. Then call ${toolName('report_outcome')} with the right outcome. Do not start new work.`

// The runner note naming a build task's pinned design (D20), or why it's missing
export function pinnedDesignNote(job: RunJob, saved: { ok: true, design: SavedDesign } | { ok: false, error: string }): string {
  if (!saved.ok) return `- The pinned design could not be saved (${saved.error}). Fetch it with ${toolName('get_design')} and taskRef "${job.taskRef}".`
  const { design } = saved
  return `- The pinned design, v${design.version} of ${design.taskRef}, is saved read-only in ${design.dir}, outside the repository: the spec at ${design.specPath}, the screenshots in ${join(design.dir, 'screenshots')} and the prototype's bundle at ${design.bundle.index}. It was built on branch ${design.branch}, for reference only.`
}

// Machine-specific details the agent needs, kept out of RunJob (PRD §8.5)
function runnerNotes(job: RunJob, scratchDir: string, design: string | null): string {
  return [
    '## Corral runner notes',
    '',
    `- Your Corral tools are on the MCP server "${CORRAL_MCP_SERVER}": ${toolsForJob(job).join(', ')}.`,
    `- Save evidence files and other scratch output under ${scratchDir} (outside the repository), then attach them with ${toolName('attach_evidence')} using the absolute path.`,
    isGlobalPmJob(job) ? '- This is a global session with no repository checkout or worktree. Start a project thread when you need to read code.' : '',
    isAuthoringRole(job.role) && job.branch ? `- You are in a git worktree on branch ${job.branch}. Pushing is disabled.` : '',
    design ?? '',
    job.role === 'pm' ? '' : '- Wait for long commands, such as checks and CI, inside your turn: run them in the foreground. Your session ends with your turn and stops anything still in the background, so never end your turn to wait for one.',
    `- This run has a time limit of ${Math.round(job.timeoutSeconds / 60)} minutes.`
  ].filter(Boolean).join('\n')
}

// The commit message of the work a stopped run left behind
export function wipMessage(job: RunJob, exit: RunExit, stopDetail: string): string {
  const reason = exit.kind === 'timed_out'
    ? 'Time limit reached'
    : exit.kind === 'runner_shutdown'
      ? 'The runner shut down'
      : exit.kind === 'signalled' ? exit.signal : stopDetail
  return `WIP: ${job.taskRef ?? 'Task fix'} run #${job.runNumber} stopped: ${reason}\n\nCorral saved this unfinished work when the run stopped. It may not build.`
}
