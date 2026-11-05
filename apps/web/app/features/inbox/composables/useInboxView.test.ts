// @vitest-environment happy-dom
import type { Inbox, InboxItem } from '@corral/contracts'
import { useMutation, VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { inboxTabs, provideInboxView } from '~/features/inbox/composables/useInboxView'
import { inbox, tasks } from '~/prototype/fixtures'
import { invalidateKeys } from '~/queries/dependencies'
import { holdsInbox } from '~/queries/inbox'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'

vi.mock('~/composables/useApi', () => ({ api: { inbox: { get: vi.fn(), read: vi.fn() }, tasks: { byRef: vi.fn() } } }))

const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(() => {
  wrappers.splice(0).forEach(w => w.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const taskItem = (data: Inbox, type: InboxItem['type'] = 'failed') => data.needsYou.find(i => i.type === type && i.taskRef)!

// The view as pages/inbox.vue provides it, with an action that holds the list
// (as useInboxItem's does) driven by the test
async function mountView({ selected = null as string | null, docked = null as string | null, data = inbox() } = {}) {
  for (const name of ['ref', 'shallowRef', 'computed', 'watch', 'watchEffect', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  const params = vue.reactive<{ itemId?: string }>({ itemId: selected ?? undefined })
  const replace = vi.fn(async ({ path }: { path: string }) => {
    params.itemId = path.split('/')[2]
  })
  const flyout = { ref: vue.ref(docked), epic: vue.ref(null), open: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('useRoute', () => ({ params }))
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.stubGlobal('useTaskFlyout', () => flyout)
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('usePlanThreadDelete', () => ({ pending: vue.ref([]), remove: vi.fn() }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  let served = data
  vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(served))
  vi.mocked(api.inbox.read).mockResolvedValue({})
  vi.mocked(api.tasks.byRef).mockImplementation(async ref => structuredClone(tasks.find(t => t.ref === ref)!))
  const client = testQueryClient()
  let view!: ReturnType<typeof provideInboxView>
  let resolving!: ReturnType<typeof useMutation<void, Error, Promise<void>>>
  wrappers.push(mount(vue.defineComponent({
    setup() {
      view = provideInboxView()
      resolving = useMutation({ ...holdsInbox, mutationFn: (pending: Promise<void>) => pending })
      return () => null
    }
  }), { global: { plugins: [[VueQueryPlugin, { queryClient: client }]] } }))
  await flushPromises()
  // Before the Inbox loads there is no selection to show, which closes the dock
  flyout.close.mockClear()
  const refresh = async () => {
    await invalidateKeys(client, [keys.inbox()])
    await flushPromises()
  }
  // An action on the selected item that is still running
  const startAction = () => {
    let finish!: () => void
    let fail!: (error: Error) => void
    const sending = resolving.mutateAsync(new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = reject
    }))
    return { sending, finish, fail }
  }
  const ids = () => view.items.value.map(i => i.id)
  return { view, params, replace, flyout, refresh, startAction, ids, serve: (next: Inbox) => {
    served = next
  } }
}

describe('inboxTabs', () => {
  it('lists the server\'s decisions and resolved items, leaving informational items out', () => {
    const server = inbox()
    expect(inboxTabs(server)).toEqual({ needsYou: server.needsYou, resolved: server.resolved })
  })

  it('has empty tabs before the Inbox loads', () => {
    expect(inboxTabs(null)).toEqual({ needsYou: [], resolved: [] })
  })
})

describe('the Inbox selection', () => {
  it('keeps the selection, list and count when an informational update arrives', async () => {
    const data = inbox()
    const item = taskItem(data)
    const v = await mountView({ selected: item.id, data })
    const before = v.ids()
    const count = v.view.count.value
    const note = { ...data.activity.find(i => i.type === 'release_notes')!, id: 'new-note', at: '2099-01-01T00:00:00.000Z' }
    v.serve({ ...data, activity: [note, ...data.activity] })
    await v.refresh()
    expect(v.ids()).toEqual(before)
    expect(v.view.count.value).toBe(count)
    expect(v.view.selected.value?.id).toBe(item.id)
    expect(v.replace).not.toHaveBeenCalled()
  })

  it('reads an unread item when it opens, clearing its dot before the request returns, without refetching the Inbox', async () => {
    const data = inbox()
    const v = await mountView({ data })
    const item = data.needsYou.find(i => i.unread && i.type !== 'plan_thread')!
    vi.mocked(api.inbox.get).mockClear()
    vi.mocked(api.inbox.read).mockReturnValue(new Promise(() => {}))
    v.params.itemId = item.id
    await flushPromises()
    expect(api.inbox.read).toHaveBeenCalledWith({ type: item.type, id: item.id })
    expect(v.view.items.value.find(i => i.id === item.id)?.unread).toBe(false)
    expect(api.inbox.get).not.toHaveBeenCalled()
  })

  it.each([
    ['nothing selected', false],
    ['a task item selected', true]
  ])('leaves the task dock alone on a live refresh, with %s', async (_, selecting) => {
    const data = inbox()
    const v = await mountView({ selected: selecting ? taskItem(data).id : null, docked: 'COR-1', data })
    await v.refresh()
    expect(v.flyout.close).not.toHaveBeenCalled()
    expect(v.flyout.open).not.toHaveBeenCalled()
  })
})

describe('while an action on the selected item runs', () => {
  it('holds the list, then moves to the item at the same position', async () => {
    const data = inbox()
    const item = taskItem(data)
    const v = await mountView({ selected: item.id, data })
    const before = v.ids()
    const position = before.indexOf(item.id)
    const action = v.startAction()
    await flushPromises()
    // The server drops the item and a row above it before the response lands
    const remaining = { ...data, needsYou: data.needsYou.filter((i, index) => i.id !== item.id && index !== 0) }
    v.serve(remaining)
    await v.refresh()
    expect(v.ids()).toEqual(before)
    expect(v.view.selected.value?.id).toBe(item.id)
    action.finish()
    await action.sending
    await v.view.moveToNext()
    const next = remaining.needsYou[Math.min(position, remaining.needsYou.length - 1)]!
    expect(v.replace).toHaveBeenCalledExactlyOnceWith({ path: `/inbox/${next.id}`, query: {} })
  })

  it('moves on with the dock left open, even when the item left the list first', async () => {
    const data = inbox()
    const item = taskItem(data)
    const next = data.needsYou.find(i => i.taskRef && i.id !== item.id)!
    const v = await mountView({ selected: item.id, docked: 'COR-1', data })
    const action = v.startAction()
    await flushPromises()
    v.serve({ ...data, needsYou: [next], resolved: [], activity: [] })
    await v.refresh()
    action.finish()
    await action.sending
    await v.view.moveToNext()
    expect(v.flyout.close).not.toHaveBeenCalled()
    expect(v.replace).toHaveBeenCalledWith({ path: `/inbox/${next.id}`, query: {} })
  })

  it('lets go of the list when the action fails, closing the dock if the item has gone', async () => {
    const data = inbox()
    const item = taskItem(data)
    const v = await mountView({ selected: item.id, docked: 'COR-1', data })
    const action = v.startAction()
    await flushPromises()
    v.serve({ ...data, needsYou: data.needsYou.filter(i => i.id !== item.id) })
    await v.refresh()
    expect(v.view.selected.value?.id).toBe(item.id)
    expect(v.flyout.close).not.toHaveBeenCalled()
    action.fail(new Error('Conflict'))
    await expect(action.sending).rejects.toThrow('Conflict')
    await flushPromises()
    expect(v.ids()).not.toContain(item.id)
    expect(v.flyout.close).toHaveBeenCalledOnce()
    expect(v.replace).not.toHaveBeenCalled()
  })
})

describe('moving on after resolving', () => {
  async function resolved(remaining: (data: Inbox, item: InboxItem) => Inbox) {
    const data = inbox()
    const item = taskItem(data)
    const v = await mountView({ selected: item.id, data })
    const action = v.startAction()
    await flushPromises()
    v.serve(remaining(data, item))
    await v.refresh()
    action.finish()
    await action.sending
    return v
  }

  it('opens the next decision, past release notes', async () => {
    const data = inbox()
    const next = data.needsYou.find(i => i.taskRef && i.id !== taskItem(data).id)!
    const note = data.activity.find(i => i.type === 'release_notes')!
    const v = await resolved(d => ({ ...d, needsYou: [next], resolved: [], activity: [note] }))
    await v.view.moveToNext()
    expect(v.replace).toHaveBeenCalledWith({ path: `/inbox/${next.id}`, query: {} })
  })

  it('opens the empty state once the last decision is resolved', async () => {
    const v = await resolved(d => ({ ...d, needsYou: [], resolved: [], activity: [] }))
    await v.view.moveToNext()
    expect(v.replace).toHaveBeenCalledWith({ path: '/inbox', query: {} })
  })

  it('leaves a newer selection alone when one is made while the next task loads', async () => {
    const v = await resolved((d, item) => ({ ...d, needsYou: d.needsYou.filter(i => i.id !== item.id && i.taskRef) }))
    let finish!: () => void
    vi.mocked(api.tasks.byRef).mockReturnValue(new Promise((resolve) => {
      finish = () => resolve(tasks[0]!)
    }))
    const moving = v.view.moveToNext()
    await flushPromises()
    const picked = v.ids().at(-1)!
    v.params.itemId = picked
    await flushPromises()
    finish()
    await moving
    expect(v.replace).not.toHaveBeenCalled()
    expect(v.params.itemId).toBe(picked)
  })

  it('moves on after a second when the next task won\'t load', async () => {
    const v = await resolved((d, item) => ({ ...d, needsYou: d.needsYou.filter(i => i.id !== item.id && i.taskRef) }))
    vi.mocked(api.tasks.byRef).mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const moving = v.view.moveToNext()
    await vi.advanceTimersByTimeAsync(999)
    expect(v.replace).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await moving
    expect(v.replace).toHaveBeenCalledOnce()
  })
})
