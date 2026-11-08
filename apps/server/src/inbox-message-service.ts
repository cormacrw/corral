import { schema, type Database } from '@corral/db'
import { eq } from 'drizzle-orm'
import type { EventBus } from './events.ts'
import type { RunnerHub } from './runner-hub.ts'
import { INBOX_CANDIDATE_STATUSES, unclaimedTaskItems } from './inbox.ts'
import { publishEpic } from './epics.ts'
import { cleanMessage, fallbackMessage, messageFacts, messagePrompt, type MessageItem, type PreparedItem } from './inbox-message.ts'
import { loadTask } from './task-views.ts'
import { unclaimedEpicItems } from './inbox-epics.ts'

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
      if (event.type === 'task.updated' && INBOX_CANDIDATE_STATUSES.includes(event.task.status)) this.refresh(event.task.id, 'task')
      // What puts an epic in the Inbox (a sync error, a fix's question) isn't
      // all on the event, so the Inbox's own query decides
      if (event.type === 'epic.updated') this.refresh(event.epic.id, 'epic')
    })
    this.refresh()
  }

  refresh(id?: string, kind?: 'task' | 'epic'): void {
    this.#pending = this.#pending.then(async () => {
      const items = [...(kind === 'epic' ? [] : await unclaimedTaskItems(this.#db, id)), ...(kind === 'task' ? [] : await unclaimedEpicItems(this.#db, id))]
      for (const item of items) await this.#claim(item)
    }).catch(error => console.error('Preparing Inbox messages failed', error))
  }

  async #claim({ item, arrival }: PreparedItem): Promise<void> {
    const [facts] = await messageFacts(this.#db, [item])
    const [claimed] = await this.#db.insert(schema.inboxMessages).values({ arrival, message: fallbackMessage(item, facts!) })
      .onConflictDoNothing().returning()
    if (!claimed) return
    // Do not await the model: neither arrivals nor subsequent items wait on it.
    void this.#generate(item, arrival, messagePrompt(item, facts!))
  }

  async #generate(item: MessageItem, arrival: string, prompt: string): Promise<void> {
    try {
      const result = await this.#runner.request({ kind: 'inbox_message', prompt })
      const message = cleanMessage(result.message)
      if (!message) throw new Error('Unusable Inbox message')
      await this.#db.update(schema.inboxMessages).set({ message }).where(eq(schema.inboxMessages.arrival, arrival))
      // Existing entity events already invalidate the Inbox query. The message
      // is keyed to its arrival, so an old completion cannot affect a new one.
      if (item.taskId) {
        this.#events.publish({ type: 'task.updated', task: await loadTask(this.#db, item.taskId) })
      } else if (item.epicId) {
        await publishEpic(this.#db, this.#events, item.epicId)
      }
    } catch (error) {
      console.error(`Generating Inbox message ${arrival} failed; keeping fallback`, error instanceof Error ? error.message : error)
    }
  }
}
