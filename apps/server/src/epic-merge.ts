import { ACTIVE_RUN_STATES, type Actor } from '@corral/core'
import { schema } from '@corral/db'
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { appendAudit, auditEvent, type EpicPrDetail } from './audit.ts'
import { publishEpicDependents } from './dependent-tasks.ts'
import { getEpic } from './epics.ts'
import { complete, createEpicFixTask, epicBoard } from './epic-prs.ts'
import type { CheckResult, PullRequest } from './github.ts'
import type { MergeDeps } from './merge.ts'
import { loadTask, type ProjectRow } from './tasks.ts'

const { epics, projects, runs } = schema
const server: Actor = { kind: 'system', component: 'server' }
type EpicRow = typeof epics.$inferSelect

// After this many failed merges the epic PR goes back to the human
const MAX_MERGE_ATTEMPTS = 3
// How long a requested rebase may take to show on the PR. Past this the
// request is taken as lost (a crash before it reached GitHub) and made again.
const REBASE_WAIT_MS = 5 * 60_000

// flows.md §4 steps 6–7. An approved epic PR rebases onto the target branch
// when that has moved, waits for its gates, then squash-merges: one commit on
// the target branch, whatever the project's method for task PRs. Unlike a
// task, it isn't told about a moved target by `mergeable_state`, which only
// says `behind` when branch protection requires it, so this compares commits.
export class EpicMerger {
  #d: MergeDeps
  #attempts = new Map<string, number>()
  // Epics being advanced right now: a slow pass can overlap the next one
  #busy = new Set<string>()

  constructor(deps: MergeDeps) {
    this.#d = deps
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date()
  }

  get inFlight(): number {
    return this.#busy.size
  }

  // Every state is read, so a PR merged by hand on GitHub still counts
  async tick(stopped: () => boolean): Promise<void> {
    const open = await this.#d.db.select({ epic: epics, project: projects }).from(epics)
      .innerJoin(projects, eq(projects.id, epics.projectId))
      .where(and(ne(epics.reviewState, 'merged'), isNotNull(epics.prNumber), eq(projects.paused, false)))
      .orderBy(asc(epics.updatedAt))
    for (const { epic, project } of open) {
      if (stopped()) return
      if (this.#busy.has(epic.id)) continue
      this.#busy.add(epic.id)
      try {
        await this.#advance(epic, project)
      } catch (error) {
        console.error(`Merge check for epic ${epic.id} failed`, error)
      } finally {
        this.#busy.delete(epic.id)
      }
    }
  }

  async #advance(epic: EpicRow, project: ProjectRow): Promise<void> {
    const { github } = this.#d
    const pr = await github.getPullRequest(project.repository, epic.prNumber!)
    if (pr.merged) return this.#recordMerged(epic, project, pr)
    if (epic.reviewState !== 'ready_to_merge') return
    if (pr.state === 'closed') return this.#leave(epic, project, 'open', {}, { event: 'closed' })

    if (pr.headSha !== epic.prHeadSha) {
      // Any other new head is the reconcile pass's: it starts a fresh review
      if (epic.rebaseRequested) await this.#leave(epic, project, 'ready_to_merge', { prHeadSha: pr.headSha, rebaseRequested: false }, { event: 'rebased', from: epic.prHeadSha, to: pr.headSha })
      return
    }
    if (epic.rebaseRequested) {
      // GitHub hasn't shown the new head yet
      if (this.#now().getTime() - epic.updatedAt.getTime() >= REBASE_WAIT_MS) await this.#clearRebase(epic)
      return
    }

    // Before CI: its result would be for a stale base, and GitHub doesn't
    // run pull_request workflows while a PR conflicts
    if (await github.behindBy(project.repository, project.defaultBranch, pr.headSha) > 0) {
      return this.#rebase(epic, project, pr)
    }
    if (pr.mergeable === false) return this.#conflict(epic, project)

    const checks = await github.checks(project.repository, pr.headSha)
    const failed = project.requiredChecks
      .map(name => checks.find(c => c.name === name))
      .filter((c): c is CheckResult => c?.conclusion === 'failure')
    if (failed.length > 0) return this.#ciFailed(epic, project, failed)
    if (project.requiredChecks.some(name => !checks.some(c => c.name === name && c.conclusion === 'success'))) return
    if (pr.mergeable === null) return // GitHub is still computing mergeability

    await this.#merge(epic, project, pr)
  }

  // The flag goes first: GitHub moves the head before updateBranch returns,
  // and a reconcile pass that saw the new head unflagged would restart review
  async #rebase(epic: EpicRow, project: ProjectRow, pr: PullRequest): Promise<void> {
    const { db, github } = this.#d
    const [flagged] = await db.update(epics).set({ rebaseRequested: true, updatedAt: this.#now() })
      .where(and(eq(epics.id, epic.id), eq(epics.reviewState, 'ready_to_merge'), eq(epics.prHeadSha, pr.headSha), eq(epics.rebaseRequested, false)))
      .returning({ id: epics.id })
    if (!flagged) return
    let updated: boolean
    try {
      updated = await github.updateBranch(project.repository, pr, pr.headSha)
    } catch (error) {
      await this.#clearRebase(epic)
      throw error
    }
    if (!updated) return this.#conflict(epic, project)
    await appendAudit(db, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId: epic.id, event: 'rebase_requested', headSha: pr.headSha }))
    this.#d.events.publish({ type: 'epic.updated', epic: await getEpic(db, epic.id) })
  }

  async #clearRebase(epic: EpicRow): Promise<void> {
    await this.#d.db.update(epics).set({ rebaseRequested: false, updatedAt: this.#now() }).where(eq(epics.id, epic.id))
  }

  // Writes the epic's next state unless a task or human action changed it
  async #leave(epic: EpicRow, project: ProjectRow, reviewState: EpicRow['reviewState'], values: Partial<EpicRow>, detail: EpicPrDetail): Promise<void> {
    const { db } = this.#d
    const [moved] = await db.update(epics).set({ reviewState, ...values, updatedAt: this.#now() })
      .where(and(eq(epics.id, epic.id), eq(epics.reviewState, 'ready_to_merge'))).returning({ id: epics.id })
    if (!moved) return
    await appendAudit(db, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId: epic.id, ...detail }))
    this.#d.events.publish({ type: 'epic.updated', epic: await getEpic(db, epic.id) })
  }

  async #conflict(epic: EpicRow, project: ProjectRow): Promise<void> {
    const files = await this.#d.runner.request({ kind: 'rebase_conflicts', repository: project.repository, branch: epic.branch!, onto: project.defaultBranch })
      .then(result => result.files)
      .catch((error: unknown) => {
        console.error(`Finding the conflicts of epic ${epic.id} failed`, error)
        return []
      })
    await this.#leave(epic, project, 'conflict', { conflictFiles: files, rebaseRequested: false }, { event: 'conflict', summary: files.join(', '), files })
  }

  // Like a task's CI failure, but the work to fix it is a task in the epic
  async #ciFailed(epic: EpicRow, project: ProjectRow, failed: CheckResult[]): Promise<void> {
    const { db, events } = this.#d
    const lines = failed.map(c => `${c.name}: failed${c.url ? ` (${c.url})` : ''}`).join('; ')
    const taskId = await db.transaction(tx => createEpicFixTask(tx, project, epic, `CI failed on the epic PR. ${lines}`, server))
    await appendAudit(db, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId: epic.id, event: 'ci_failed', summary: lines }))
    events.publish({ type: 'task.created', task: await loadTask(db, taskId) })
    events.publish({ type: 'epic.updated', epic: await getEpic(db, epic.id) })
    this.#d.wake?.([taskId])
  }

  // Never records a merge without GitHub showing it, as for tasks. The lock
  // keeps a task from joining the board while GitHub is merging.
  async #merge(epic: EpicRow, project: ProjectRow, pr: PullRequest): Promise<void> {
    const { db, github } = this.#d
    const attempt = (this.#attempts.get(epic.id) ?? 0) + 1
    this.#attempts.set(epic.id, attempt)
    let failure: string | null
    try {
      failure = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(epics).where(eq(epics.id, epic.id)).for('update')
        if (locked?.reviewState !== 'ready_to_merge' || locked.prHeadSha !== pr.headSha || !complete(await epicBoard(tx, epic.id))) return null
        const result = await github.merge(project.repository, pr.number, 'squash', pr.headSha)
        return result.merged ? null : result.message
      })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const again = await github.getPullRequest(project.repository, pr.number).catch(() => null)
    if (again?.merged) return this.#recordMerged(epic, project, again)
    if (failure === null) return
    await appendAudit(db, { projectId: project.id, actor: server }, auditEvent('merge.refused', { epicId: epic.id, pr: pr.number, message: failure, attempt }))
    if (attempt < MAX_MERGE_ATTEMPTS) return
    // Approving again retries the merge
    this.#attempts.delete(epic.id)
    await this.#leave(epic, project, 'human_review', {}, { event: 'merge_refused', summary: failure })
  }

  async #recordMerged(epic: EpicRow, project: ProjectRow, pr: PullRequest): Promise<void> {
    const { db, events, github, runner } = this.#d
    await db.transaction(async (tx) => {
      await tx.update(epics).set({ reviewState: 'merged', mergeCommitSha: pr.mergeCommitSha, prHeadSha: pr.headSha, rebaseRequested: false, conflictFiles: null, updatedAt: this.#now() }).where(eq(epics.id, epic.id))
      await tx.update(runs).set({ state: 'interrupted', endedAt: this.#now(), error: 'Epic PR merged' })
        .where(and(eq(runs.epicId, epic.id), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      await appendAudit(tx, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId: epic.id, event: 'merged', pr: pr.number, mergeCommitSha: pr.mergeCommitSha }))
    })
    this.#attempts.delete(epic.id)
    events.publish({ type: 'epic.updated', epic: await getEpic(db, epic.id) })
    this.#d.wake?.(await publishEpicDependents(db, events, epic.id))
    await github.deleteBranch(project.repository, epic.branch!).catch(error => console.error(`Deleting ${epic.branch} failed`, error))
    await runner.request({ kind: 'cleanup_worktrees', repository: project.repository, taskId: `epic-${epic.id}` })
      .catch(error => console.error(`Worktree cleanup for epic ${epic.id} failed`, error))
  }
}
