import { schema, type Database } from '@corral/db'
import { eq } from 'drizzle-orm'
import type { EventBus } from './events.ts'
import type { RunnerHub } from './runner-hub.ts'
import { taskMessageItems } from './inbox.ts'
import { loadTask } from './tasks.ts'
import { getEpic } from './epics.ts'
import { epicInboxItems } from './epic-prs.ts'
import { arrivalKey, cleanMessage, fallbackMessage, messageFacts, messagePrompt, type MessageItem } from './inbox-message.ts'

// Runs on arrivals, never on reads. The durable insert is also the claim:
// duplicate events and server restarts cannot dispatch a second job.
export class InboxMessages {
  #pending = Promise.resolve()

  #db: Database
  #events: EventBus
  #runner: RunnerHub

  constructor(db: Database, events: EventBus, runner: RunnerHub) {
    this.#db = db
    this.#events = events
    this.#runner = runner
    events.subscribe((event) => {
      if (event.type === 'task.updated' && ['human_review', 'blocked', 'failed'].includes(event.task.status)) this.refresh(event.task.id, 'task')
      if (event.type === 'epic.updated' && ['human_review', 'conflict'].includes(event.epic.reviewState ?? '')) this.refresh(event.epic.id, 'epic')
    })
    this.refresh()
  }

  refresh(id?: string, kind?: 'task' | 'epic'): void {
    this.#pending = this.#pending.then(async () => {
      const items = [...(kind === 'epic' ? [] : await taskMessageItems(this.#db, id)), ...(kind === 'task' ? [] : await epicInboxItems(this.#db, id))]
      for (const item of items) await this.#claim(item)
    }).catch(error => console.error('Preparing Inbox messages failed', error))
  }

  async #claim(item: MessageItem): Promise<void> {
    const arrival = await arrivalKey(this.#db, item)
    const [existing] = await this.#db.select().from(schema.inboxMessages).where(eq(schema.inboxMessages.arrival, arrival))
    if (existing) return
    const facts = await messageFacts(this.#db, item)
    const [claimed] = await this.#db.insert(schema.inboxMessages).values({ arrival, message: fallbackMessage(item, facts) })
      .onConflictDoNothing().returning()
    if (!claimed) return
    // Do not await the model: neither arrivals nor subsequent items wait on it.
    void this.#generate(item, arrival, messagePrompt(item, facts))
  }

  async #generate(item: MessageItem, arrival: string, prompt: string): Promise<void> {
    try {
      const result = await this.#runner.request({ kind: 'inbox_message', prompt }, 40_000)
      const message = cleanMessage(result.message)
      if (!message) throw new Error('Unusable Inbox message')
      await this.#db.update(schema.inboxMessages).set({ message }).where(eq(schema.inboxMessages.arrival, arrival))
      // Existing entity events already invalidate the Inbox query. The message
      // is keyed to its arrival, so an old completion cannot affect a new one.
      if (item.taskId) {
        this.#events.publish({ type: 'task.updated', task: await loadTask(this.#db, item.taskId) })
      } else if ('epicId' in item) {
        this.#events.publish({ type: 'epic.updated', epic: await getEpic(this.#db, item.epicId) })
      }
    } catch (error) {
      console.error(`Generating Inbox message ${arrival} failed; keeping fallback`, error instanceof Error ? error.message : error)
    }
  }
}
