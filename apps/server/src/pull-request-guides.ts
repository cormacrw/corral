import { randomUUID } from 'node:crypto'
import { splitPatchHunks, type PullRequestFile, type PullRequestGuide } from '@corral/contracts'
import { errorText, richTextToMarkdown, taskRef, type PullRequestGuideStep } from '@corral/core'
import { schema, type Database, type ProjectRow } from '@corral/db'
import { and, eq, lt, ne, or } from 'drizzle-orm'
import { ApiFailure } from './errors.ts'
import type { GitHubClient } from './github.ts'
import { pullRequestUnavailable } from './pull-requests.ts'
import type { RunnerHub } from './runner-hub.ts'
import { taskCriteria } from './criteria.ts'

const { pullRequestGuides, tasks } = schema

// Guided code review (COR-525, .corral/wiki/pr-guides.md). A guide is made
// only when a reviewer asks: the server reads the PR's diff, the runner's small
// model orders its hunks into steps, and the server keeps only refs that exist.

// GitHub's most files per page; a guide sees more than the panel's capped diff,
// so a step can say a hunk is past the cap
const GUIDE_FILE_LIMIT = 100
// Patch text the prompt carries in all; files past it go in by name only
const GUIDE_PATCH_CHARS = 80_000
// A guide still generating after this was lost with a restart or a runner
const GENERATING_STALE_MS = 5 * 60_000

type GuideRow = typeof pullRequestGuides.$inferSelect

export interface GuideInput {
  task: { ref: string, title: string, goal: string, criteria: { id: string, text: string }[] } | null
  pr: { title: string, body: string }
  files: PullRequestFile[]
}

export class PullRequestGuides {
  #d: { db: Database, github: GitHubClient, runner: Pick<RunnerHub, 'request'> }
  #running = new Set<Promise<void>>()

  constructor(d: { db: Database, github: GitHubClient, runner: Pick<RunnerHub, 'request'> }) {
    this.#d = d
  }

  async get(project: ProjectRow, number: number): Promise<PullRequestGuide> {
    const [row] = await this.#d.db.select().from(pullRequestGuides)
      .where(and(eq(pullRequestGuides.projectId, project.id), eq(pullRequestGuides.prNumber, number)))
    return toGuide(row)
  }

  // Starts a guide for the PR's head commit and returns at once. While one is
  // generating, asking again returns it rather than starting another.
  async generate(project: ProjectRow, number: number): Promise<PullRequestGuide> {
    const { db, github } = this.#d
    let diff: Awaited<ReturnType<GitHubClient['getPullRequestDiff']>>
    try {
      diff = await github.getPullRequestDiff(project.repository, number, GUIDE_FILE_LIMIT)
    } catch (error) {
      throw pullRequestUnavailable(error, number)
    }
    const now = new Date()
    const values = { status: 'generating' as const, headSha: diff.headSha, steps: [], error: null, generatedAt: null, updatedAt: now }
    const [claimed] = await db.insert(pullRequestGuides).values({ projectId: project.id, prNumber: number, ...values })
      .onConflictDoUpdate({
        target: [pullRequestGuides.projectId, pullRequestGuides.prNumber],
        set: values,
        setWhere: or(ne(pullRequestGuides.status, 'generating'), lt(pullRequestGuides.updatedAt, new Date(now.getTime() - GENERATING_STALE_MS)))!
      })
      .returning()
    if (!claimed) return this.get(project, number)
    const input: GuideInput = { task: await this.#task(project, number), pr: { title: diff.title, body: diff.body }, files: diff.files }
    const run = this.#run(project.id, number, now, input).finally(() => this.#running.delete(run))
    this.#running.add(run)
    return toGuide(claimed)
  }

  // For tests and shutdown: every generation started so far has settled
  async idle(): Promise<void> {
    while (this.#running.size) await Promise.allSettled([...this.#running])
  }

  async #task(project: ProjectRow, number: number): Promise<GuideInput['task']> {
    const { db } = this.#d
    const [task] = await db.select({ id: tasks.id, number: tasks.number, title: tasks.title, description: tasks.description }).from(tasks)
      .where(and(eq(tasks.projectId, project.id), eq(tasks.prNumber, number)))
    if (!task) return null
    const criteria = (await taskCriteria(db, task.id)).map(({ id, text }) => ({ id, text }))
    return { ref: taskRef(project.prefix, task.number), title: task.title, goal: richTextToMarkdown(task.description), criteria }
  }

  async #run(projectId: string, number: number, startedAt: Date, input: GuideInput): Promise<void> {
    let update: Partial<GuideRow>
    try {
      const result = await this.#d.runner.request({ kind: 'pr_guide', prompt: guidePrompt(input) })
      const steps = parseGuide(result.text, input)
      update = { status: 'ready', steps, error: null, generatedAt: new Date() }
    } catch (error) {
      const message = error instanceof ApiFailure && error.body.code === 'runner_offline'
        ? 'No runner is online to generate it.'
        : errorText(error)
      update = { status: 'failed', steps: [], error: message.slice(0, 500) }
    }
    // Only the generation that claimed the row may finish it
    await this.#d.db.update(pullRequestGuides).set({ ...update, updatedAt: new Date() })
      .where(and(eq(pullRequestGuides.projectId, projectId), eq(pullRequestGuides.prNumber, number), eq(pullRequestGuides.status, 'generating'), eq(pullRequestGuides.updatedAt, startedAt)))
  }
}

function toGuide(row: GuideRow | undefined, now = Date.now()): PullRequestGuide {
  if (!row) return { status: 'none', headSha: null, steps: [], error: null, generatedAt: null }
  const lost = row.status === 'generating' && row.updatedAt.getTime() < now - GENERATING_STALE_MS
  return {
    status: lost ? 'failed' : row.status as PullRequestGuide['status'],
    headSha: row.headSha,
    steps: row.steps,
    error: lost ? 'Generation stopped before it finished.' : row.error,
    generatedAt: row.generatedAt?.toISOString() ?? null
  }
}

// The task, then each file's hunks numbered from 0, as the model must cite them
export function guidePrompt(input: GuideInput): string {
  const { task, pr } = input
  let budget = GUIDE_PATCH_CHARS
  const files = input.files.map((file) => {
    const hunks = splitPatchHunks(file.patch)
    const size = hunks.reduce((n, h) => n + h.join('\n').length, 0)
    if (!hunks.length || size > budget) return `## ${file.path} (${file.status}, no hunks shown)`
    budget -= size
    return [`## ${file.path} (${file.status})`, ...hunks.map((lines, i) => `### ${file.path} · hunk ${i}\n${lines.join('\n')}`)].join('\n')
  })
  return [
    'You are helping a reviewer read a pull request as a story. Order its changed hunks into steps that explain the change in the order a reader should follow it: the core idea first, then what builds on it, tests and docs last.',
    '',
    'Reply with JSON only, no prose and no code fence, in this shape:',
    '{"steps":[{"title":"Short title","why":"One or two sentences on why this step matters for the task.","criterionIds":["<criterion id>"],"hunks":[{"path":"<file path>","hunk":0}]}]}',
    '',
    'Rules:',
    '- Cite hunks only by the file paths and hunk numbers given below. Each hunk goes in at most one step.',
    '- Leave out trivial hunks (imports, formatting) you have nothing to say about; they are shown separately.',
    '- criterionIds are the ids in brackets of the acceptance criteria a step works towards, or [].',
    '- Use between 1 and 8 steps. Titles under 60 characters.',
    '',
    '# Task',
    task ? `${task.ref}: ${task.title}` : '(no task)',
    task?.goal ? `\n${task.goal}` : '',
    '',
    '# Acceptance criteria',
    ...task?.criteria.length ? task.criteria.map(c => `- [${c.id}] ${c.text}`) : ['(none)'],
    '',
    '# Pull request',
    pr.title,
    '',
    '# Changed files',
    ...files
  ].join('\n')
}

// The model's steps, keeping only refs that exist: unknown paths, hunks and
// criteria are dropped, and so is a hunk a step before already took. A step
// left with no hunks goes too. Throws when nothing usable came back.
export function parseGuide(text: string, input: GuideInput): PullRequestGuideStep[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('The model\'s answer wasn\'t valid JSON.')
  }
  const list = (raw as { steps?: unknown })?.steps
  if (!Array.isArray(list)) throw new Error('The model\'s answer had no steps.')
  const hunkCounts = new Map(input.files.map(f => [f.path, splitPatchHunks(f.patch).length]))
  const criterionIds = new Set(input.task?.criteria.map(c => c.id) ?? [])
  const used = new Set<string>()
  const steps: PullRequestGuideStep[] = []
  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 120) : ''
    const why = typeof item.why === 'string' ? item.why.trim().slice(0, 600) : ''
    const hunks: PullRequestGuideStep['hunks'] = []
    for (const h of Array.isArray(item.hunks) ? item.hunks as Record<string, unknown>[] : []) {
      const path = typeof h?.path === 'string' ? h.path : ''
      const hunk = typeof h?.hunk === 'number' ? h.hunk : Number.NaN
      const count = hunkCounts.get(path)
      const key = `${path}#${hunk}`
      if (count === undefined || !Number.isInteger(hunk) || hunk < 0 || hunk >= count || used.has(key)) continue
      used.add(key)
      hunks.push({ path, hunk })
    }
    if (!title || !hunks.length) continue
    const ids = Array.isArray(item.criterionIds) ? [...new Set(item.criterionIds.filter((id): id is string => typeof id === 'string' && criterionIds.has(id)))] : []
    steps.push({ id: randomUUID(), title, why, criterionIds: ids, hunks })
  }
  if (!steps.length) throw new Error('The model\'s answer had no steps that cite this PR\'s hunks.')
  return steps
}
