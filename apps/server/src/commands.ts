import type { Agent, Comment, CreateAgentInput, CreateProjectInput, CreateTaskInput, Epic, EpicDetail, HumanTransitionInput, PatchAgentInput, PatchEpicInput, PatchProfileInput, PatchProjectInput, PatchTaskInput, Profile, Project, Task } from '@corral/contracts'
import type { Actor } from '@corral/core'
import type { Database, ProjectRow, TaskRow } from '@corral/db'
import { patchProfile, setAgentAvatar, setUserAvatar, type AvatarImage } from './avatars.ts'
import type { BlobStore } from './blob-store.ts'
import { addComment } from './comments.ts'
import { getEpic, patchEpic, setEpicDependencies, withInvalidatedEpics } from './epics.ts'
import type { EventBus } from './events.ts'
import type { MergeOrchestrator } from './merge.ts'
import { createProject, patchProject, setProjectThumbnail } from './projects.ts'
import { createAgent, listAgents, patchAgent } from './runs.ts'
import type { RunnerHub } from './runner-hub.ts'
import { requireRuntimeCli } from './setup.ts'
import { loadTask } from './task-views.ts'
import { addSubtask, createTask, patchTask, transitionTask, type TaskContentEdit } from './tasks.ts'

export interface CommandsDeps {
  db: Database
  events: EventBus
  blobs: BlobStore
  runner: RunnerHub
  merges: Pick<MergeOrchestrator, 'humanApprove'>
  now(): Date
  // Tells a run holding the task about an edit to the text it works to
  noticeTaskEdit(taskId: string, edit: TaskContentEdit, actor: Actor): Promise<void>
  wake(taskIds?: readonly string[]): void
}

// The changes people and the PM make to projects, agents, tasks and parents.
// Each commits, publishes what it changed (with the epics whose review it
// invalidated) and wakes the scheduler where work may now start, so the HTTP
// routes and the PM's tools do the same thing.
export class Commands {
  #d: CommandsDeps

  constructor(deps: CommandsDeps) {
    this.#d = deps
  }

  async createProject(input: CreateProjectInput, actor: Actor): Promise<Project> {
    const project = await createProject(this.#d.db, input, actor)
    this.#d.events.publish({ type: 'project.created', project })
    return project
  }

  async patchProject(row: ProjectRow, input: PatchProjectInput, actor: Actor): Promise<Project> {
    const project = await patchProject(this.#d.db, row, input, actor)
    this.#d.events.publish({ type: 'project.updated', project })
    this.#d.wake()
    return project
  }

  async setProjectThumbnail(row: ProjectRow, blob: string | null, actor: Actor): Promise<Project> {
    const project = await setProjectThumbnail(this.#d.db, row, blob, actor)
    this.#d.events.publish({ type: 'project.updated', project })
    return project
  }

  async createAgent(input: CreateAgentInput, actor: Actor): Promise<Agent> {
    await requireRuntimeCli(this.#d.runner, input.runtime)
    return this.#agentChanged(await createAgent(this.#d.db, input, actor))
  }

  async patchAgent(agentId: string, input: PatchAgentInput, actor: Actor): Promise<Agent> {
    if (input.runtime) await requireRuntimeCli(this.#d.runner, input.runtime)
    return this.#agentChanged(await patchAgent(this.#d.db, agentId, input, actor))
  }

  async setAgentAvatar(agentId: string, image: AvatarImage): Promise<Agent> {
    await setAgentAvatar(this.#d.db, this.#d.blobs, agentId, image)
    const agent = (await listAgents(this.#d.db)).find(a => a.id === agentId)!
    this.#d.events.publish({ type: 'agent.updated', agent })
    return agent
  }

  #agentChanged(agent: Agent): Agent {
    this.#d.events.publish({ type: 'agent.updated', agent })
    this.#d.wake()
    return agent
  }

  async patchProfile(userId: string, input: PatchProfileInput): Promise<Profile> {
    return this.#profileChanged(await patchProfile(this.#d.db, userId, input))
  }

  async setUserAvatar(userId: string, image: AvatarImage): Promise<Profile> {
    return this.#profileChanged(await setUserAvatar(this.#d.db, this.#d.blobs, userId, image))
  }

  #profileChanged(profile: Profile): Profile {
    this.#d.events.publish({ type: 'profile.updated', profile })
    return profile
  }

  async createTask(project: ProjectRow, input: CreateTaskInput, actor: Actor): Promise<Task> {
    const { db, events } = this.#d
    const task = await loadTask(db, await withInvalidatedEpics(db, events, invalidatedEpics => createTask(db, project, input, actor, { invalidatedEpics })))
    events.publish({ type: 'task.created', task })
    return task
  }

  // Makes a parent of the task if it isn't one yet
  async addSubtask(project: ProjectRow, taskId: string, input: CreateTaskInput, actor: Actor): Promise<Task> {
    const { db, events } = this.#d
    const created = await loadTask(db, await addSubtask(db, project, taskId, input, actor))
    events.publish({ type: 'task.created', task: created })
    if (created.parentTask) events.publish({ type: 'task.updated', task: await loadTask(db, created.parentTask.id) })
    return created
  }

  // A D10 transition the human asked for. Approval starts work at once (flows.md step 1).
  async transitionTask(taskId: string, input: HumanTransitionInput, actor: Actor, options: { comment?: string | undefined } = {}): Promise<Task> {
    const { db, events } = this.#d
    await withInvalidatedEpics(db, events, invalidatedEpics => transitionTask(db, taskId, input, actor, { ...options, invalidatedEpics }))
    return this.taskChanged(taskId)
  }

  // The edit is saved either way; telling the run is best effort (PRD §7.3).
  // `paused` pauses or resumes claims on it in the same write, and `check`
  // refuses an edit once the task is locked.
  async patchTask(project: ProjectRow, taskId: string, input: PatchTaskInput, actor: Actor, options: { paused?: boolean | undefined, check?: (task: TaskRow) => void } = {}): Promise<Task> {
    const { db, events } = this.#d
    const edit = await withInvalidatedEpics(db, events, invalidatedEpics => patchTask(db, project, taskId, input, actor, { ...options, invalidatedEpics, now: this.#d.now() }))
    if (edit) await this.#d.noticeTaskEdit(taskId, edit, actor).catch(error => console.error(`Telling the run about the edit to task ${taskId} failed`, error))
    return this.taskChanged(taskId)
  }

  // Approve a mergeable task for the merge pass; spikes finish here
  async approveTask(taskId: string, actor: Actor, note?: string): Promise<Task> {
    await this.#d.merges.humanApprove(taskId, actor, note)
    return this.taskChanged(taskId)
  }

  async addComment(taskId: string, input: { body: string, pinned: boolean }, actor: Actor): Promise<Comment> {
    const comment = await addComment(this.#d.db, taskId, input, actor)
    this.#d.events.publish({ type: 'comment.created', comment })
    return comment
  }

  async patchEpic(epicId: string, input: PatchEpicInput, actor: Actor): Promise<Epic> {
    const epic = await patchEpic(this.#d.db, epicId, input, actor)
    this.#d.events.publish({ type: 'epic.updated', epic })
    return epic
  }

  // Every epic of the project, whose waits may all have changed
  async setEpicDependencies(epicId: string, dependsOn: string[], actor: Actor): Promise<Epic[]> {
    const updated = await setEpicDependencies(this.#d.db, epicId, dependsOn, actor)
    for (const epic of updated) this.#d.events.publish({ type: 'epic.updated', epic })
    await this.#tasksOf(epicId)
    return updated
  }

  // A task with subtasks: its content and what it waits on, in one write
  async updateParent(epicId: string, change: { fields: PatchEpicInput, dependsOn?: string[] | undefined }, actor: Actor): Promise<EpicDetail> {
    await this.#d.db.transaction(async (tx) => {
      await patchEpic(tx, epicId, change.fields, actor)
      if (change.dependsOn !== undefined) await setEpicDependencies(tx, epicId, change.dependsOn, actor)
    })
    const epic = await getEpic(this.#d.db, epicId)
    this.#d.events.publish({ type: 'epic.updated', epic })
    await this.#tasksOf(epicId, epic)
    return epic
  }

  async #tasksOf(epicId: string, detail?: EpicDetail): Promise<void> {
    const { tasks } = detail ?? await getEpic(this.#d.db, epicId)
    for (const task of tasks) this.#d.events.publish({ type: 'task.updated', task })
    this.#d.wake(tasks.map(t => t.id))
  }

  // Published after the commit, so listeners never see a rolled-back state
  async taskChanged(taskId: string): Promise<Task> {
    const task = await loadTask(this.#d.db, taskId)
    this.#d.events.publish({ type: 'task.updated', task })
    this.#d.wake([taskId])
    return task
  }
}
