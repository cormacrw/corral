// @vitest-environment happy-dom
import type { EpicActivityItem, Inbox, InboxItem, Task, TaskInboxItem } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { readDraft, writeDraft } from '~/composables/useDraft'
import { useInboxItem } from '~/features/inbox/composables/useInboxItem'
import { actionDisabled } from '~/features/inbox/composables/useInboxPanel'
import { provideInboxView } from '~/features/inbox/composables/useInboxView'
import { inbox, projects, tasks } from '~/prototype/fixtures'
import { invalidateKeys } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'

vi.mock('~/composables/useApi', () => ({
  api: {
    inbox: { get: vi.fn(), act: vi.fn(), read: vi.fn() },
    tasks: { byRef: vi.fn(), evidence: vi.fn(), reviews: vi.fn() }
  }
}))

const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
})
afterEach(() => {
  wrappers.splice(0).forEach(w => w.unmount())
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

const taskItem = (data: Inbox, type: InboxItem['type'], ref?: string) => data.needsYou.find(i => i.type === type && (ref ? i.taskRef === ref : i.taskRef && tasks.find(t => t.ref === i.taskRef)?.type !== 'design'))!
const fixtureTask = (ref: string) => structuredClone(tasks.find(t => t.ref === ref)!)

interface Options {
  selected: string
  data?: Inbox
  mobile?: boolean
  docked?: string | null
  // The task as the server returns it; null fails to load
  task?: (task: Task) => Task | null
}

// The Inbox view, and the selected item's composable remounting per selection
// as pages/inbox/[itemId].vue does. One-click actions send through the
// composer, so the composer here sends what was typed.
async function mountItem({ selected, data = inbox(), mobile = false, docked = null, task = t => t }: Options) {
  for (const name of ['ref', 'shallowRef', 'computed', 'watch', 'watchEffect', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  const params = vue.reactive<{ itemId?: string }>({ itemId: selected })
  const replace = vi.fn(async ({ path }: { path: string }) => {
    params.itemId = path.split('/')[2]
  })
  const flyout = { ref: vue.ref(docked), epic: vue.ref(null), open: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('useRoute', () => ({ params }))
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.stubGlobal('useTaskFlyout', () => flyout)
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(mobile) }))
  vi.stubGlobal('usePlanThreadDelete', () => ({ pending: vue.ref([]), remove: vi.fn() }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  let served = data
  vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(served))
  vi.mocked(api.inbox.read).mockResolvedValue({})
  vi.mocked(api.inbox.act).mockResolvedValue({ task: null })
  vi.mocked(api.tasks.byRef).mockImplementation(async (ref) => {
    const loaded = task(fixtureTask(ref))
    if (!loaded) throw new Error('Server unavailable')
    return loaded
  })
  vi.mocked(api.tasks.evidence).mockResolvedValue([])
  vi.mocked(api.tasks.reviews).mockResolvedValue([])
  const client = testQueryClient()
  let current!: ReturnType<typeof useInboxItem>
  const Item = vue.defineComponent({
    setup() {
      current = useInboxItem()
      current.panelView.value = { send: () => current.ctx.submit(current.ctx.text) }
      return () => null
    }
  })
  const wrapper = mount(vue.defineComponent({
    setup() {
      const view = provideInboxView()
      return () => view.selectedId.value ? vue.h(Item, { key: view.selectedId.value }) : null
    }
  }), { global: { plugins: [[VueQueryPlugin, { queryClient: client }]] } })
  wrappers.push(wrapper)
  await flushPromises()
  flyout.close.mockClear()
  return {
    wrapper, params, replace, flyout,
    ctx: () => current.ctx,
    item: () => current,
    select: async (id: string | undefined) => {
      params.itemId = id
      await flushPromises()
    },
    serve: (next: Inbox) => {
      served = next
    },
    refresh: async () => {
      await invalidateKeys(client, [keys.inbox()])
      await flushPromises()
    }
  }
}

describe('a failed item', () => {
  it.each([
    [undefined, '', 'in_progress'],
    ['backlog', '', 'backlog'],
    ['ready', 'Use the existing API', 'ready']
  ] as const)('retries into %s with its optional note', async (to, note, sent) => {
    const failed = taskItem(inbox(), 'failed')
    const { ctx } = await mountItem({ selected: failed.id })
    if (to) ctx().setResolveTo(to)
    ctx().setText(note)
    expect(await ctx().act('resolve')).toBe(true)
    expect(api.inbox.act).toHaveBeenCalledExactlyOnceWith(failed.taskId, { action: 'resolve', to: sent, ...(note && { text: note }) })
  })

  it('goes back to the Retry note after choosing Delete then Cancel', async () => {
    const { ctx } = await mountItem({ selected: taskItem(inbox(), 'failed').id })
    expect(ctx().action).toBe('resolve')
    expect(await ctx().act('delete')).toBe(false)
    expect(ctx().composerChosen).toBe(true)
    ctx().cancelAction()
    expect(ctx().action).toBe('resolve')
    expect(api.inbox.act).not.toHaveBeenCalled()
  })

  it('asks for a reason before deleting, and sends nothing with no action chosen', async () => {
    const { ctx } = await mountItem({ selected: taskItem(inbox(), 'failed').id })
    expect(await ctx().act('delete')).toBe(false)
    expect(api.inbox.act).not.toHaveBeenCalled()
    // Comments belong on the task: the Inbox has no reply
    ctx().setAction(null)
    expect(await ctx().submit('Any news?')).toBe(false)
    expect(api.inbox.act).not.toHaveBeenCalled()
  })

  it('keeps the note and says why when the action fails', async () => {
    const { ctx } = await mountItem({ selected: taskItem(inbox(), 'failed').id })
    vi.mocked(api.inbox.act).mockRejectedValue(new Error('Conflict'))
    ctx().setText('my note')
    expect(await ctx().act('resolve')).toBe(false)
    expect(ctx().actionError).toContain('Conflict')
    expect(ctx().text).toBe('my note')
    expect(ctx().busy).toBe(false)
  })

  it('can still retry when its task fails to load', async () => {
    const failed = taskItem(inbox(), 'failed')
    const { ctx } = await mountItem({ selected: failed.id, task: () => null })
    expect(ctx().taskLoadFailed).toBe(true)
    expect(actionDisabled(ctx(), 'resolve')).toBe(false)
    expect(await ctx().act('resolve')).toBe(true)
    expect(api.inbox.act).toHaveBeenCalledWith(failed.taskId, expect.objectContaining({ action: 'resolve' }))
  })

  it('fetches evidence only once the item has new artifacts, and no reviews', async () => {
    const data = inbox()
    const failed = taskItem(data, 'failed')
    const withArtifacts = (newArtifacts: TaskInboxItem['newArtifacts']) => ({ ...data, needsYou: data.needsYou.map(i => i.id === failed.id ? { ...i, newArtifacts } : i) }) as Inbox
    const v = await mountItem({ selected: failed.id, data: withArtifacts([]) })
    expect(api.tasks.evidence).not.toHaveBeenCalled()
    v.serve(withArtifacts([{ id: 'e1', kind: 'other', name: 'report.html', url: '/api/evidence/e1/file', taskRef: null, at: failed.at }]))
    await v.refresh()
    expect(api.tasks.evidence).toHaveBeenCalled()
    expect(api.tasks.reviews).not.toHaveBeenCalled()
  })
})

describe('a question', () => {
  it.each([
    [false, null],
    [true, 'clarify']
  ] as const)('opens with mobile=%s on %s, and Cancel closes it', async (mobile, opened) => {
    const data = inbox()
    const question = data.needsYou.find(i => i.taskRef === 'COR-8')!
    question.type = 'question'
    const { ctx } = await mountItem({ selected: question.id, data, mobile })
    expect(ctx().action).toBe(opened)
    ctx().cancelAction()
    expect(ctx().action).toBeNull()
  })
})

describe('a human review', () => {
  it('approves in one click, and leaves Request changes to the composer', async () => {
    const review = taskItem(inbox(), 'human_review', 'COR-5')
    const { ctx } = await mountItem({ selected: review.id })
    expect(await ctx().act('request_changes')).toBe(false)
    expect(ctx().composerChosen).toBe(true)
    expect(api.inbox.act).not.toHaveBeenCalled()
    ctx().cancelAction()
    expect(ctx().composerChosen).toBe(false)
    expect(await ctx().act('approve')).toBe(true)
    expect(api.inbox.act).toHaveBeenCalledExactlyOnceWith(review.taskId, { action: 'approve', text: '' })
  })

  it('sends nothing for unticked human checks, opens Criteria and says why, then approves once ticked', async () => {
    const check = { id: 'check', position: 0, text: 'Looks right', met: null, checkedByHuman: true }
    const { ctx } = await mountItem({ selected: taskItem(inbox(), 'human_review', 'COR-5').id, task: t => ({ ...t, acceptanceCriteria: [check] }) })
    expect(await ctx().act('approve')).toBe(false)
    expect(api.inbox.act).not.toHaveBeenCalled()
    expect(ctx().tab).toBe('criteria')
    expect(ctx().actionError).toBeTruthy()
    ctx().setCheckedHumanCriteria(['check'])
    await vue.nextTick()
    expect(ctx().actionError).toBeNull()
    expect(await ctx().act('approve')).toBe(true)
    expect(api.inbox.act).toHaveBeenCalledOnce()
  })

  it('blocks approval, and only approval, when its task fails to load', async () => {
    const { ctx } = await mountItem({ selected: taskItem(inbox(), 'human_review', 'COR-5').id, task: () => null })
    expect(ctx().taskLoadFailed).toBe(true)
    expect(ctx().taskLoading).toBe(false)
    expect(actionDisabled(ctx(), 'approve')).toBe(true)
    expect(actionDisabled(ctx(), 'request_changes')).toBe(false)
    expect(await ctx().act('approve')).toBe(false)
    expect(api.inbox.act).not.toHaveBeenCalled()
  })

  it('keeps the load error through a live refresh, and recovers through Retry', async () => {
    const review = taskItem(inbox(), 'human_review', 'COR-5')
    const v = await mountItem({ selected: review.id, task: () => null })
    await v.refresh()
    expect(v.ctx().taskLoadFailed).toBe(true)
    let finish!: () => void
    vi.mocked(api.tasks.byRef).mockReturnValue(new Promise((resolve) => {
      finish = () => resolve(fixtureTask('COR-5'))
    }))
    v.ctx().retryTask()
    await flushPromises()
    expect(v.ctx().taskLoading).toBe(true)
    expect(actionDisabled(v.ctx(), 'approve')).toBe(true)
    finish()
    await flushPromises()
    expect(v.ctx().taskLoadFailed).toBe(false)
    expect(v.ctx().actions[0]?.value).toBe('approve')
    expect(actionDisabled(v.ctx(), 'approve')).toBe(false)
  })

  it('shows a revisited item\'s task at once from cache', async () => {
    const data = inbox()
    const design = taskItem(data, 'human_review', 'COR-41')
    const v = await mountItem({ selected: design.id, data })
    expect(v.ctx().task?.ref).toBe('COR-41')
    await v.select(taskItem(data, 'failed').id)
    vi.mocked(api.tasks.byRef).mockReturnValue(new Promise(() => {}))
    await v.select(design.id)
    expect(v.ctx().task?.ref).toBe('COR-41')
    expect(v.ctx().taskLoading).toBe(false)
  })

  it('approves a design and moves on, without a live refresh closing the dock', async () => {
    const data = inbox()
    const design = taskItem(data, 'human_review', 'COR-41')
    const v = await mountItem({ selected: design.id, data, docked: 'COR-1' })
    expect(v.ctx().task?.type).toBe('design')
    const remaining = { ...data, needsYou: data.needsYou.filter(i => i.id !== design.id) }
    v.serve(remaining)
    const sent = v.ctx().act('approve')
    void v.refresh()
    expect(await sent).toBe(true)
    expect(api.inbox.act).toHaveBeenCalledWith(design.taskId, expect.objectContaining({ action: 'approve' }))
    expect(v.flyout.close).not.toHaveBeenCalled()
    const position = data.needsYou.findIndex(i => i.id === design.id)
    const next = remaining.needsYou[Math.min(position, remaining.needsYou.length - 1)]!
    expect(v.replace).toHaveBeenCalledWith({ path: `/inbox/${next.id}`, query: {} })
  })
})

describe('the draft', () => {
  it('keeps the draft through leaving the Inbox and coming back to the item', async () => {
    const selected = taskItem(inbox(), 'human_review', 'COR-41').id
    const first = await mountItem({ selected })
    first.ctx().setText('my note')
    first.wrapper.unmount()
    wrappers.splice(wrappers.indexOf(first.wrapper), 1)
    const again = await mountItem({ selected })
    expect(again.ctx().text).toBe('my note')
  })

  it('clears the draft and checked criteria on switching to another item and back', async () => {
    const data = inbox()
    const review = taskItem(data, 'human_review', 'COR-5')
    const v = await mountItem({ selected: review.id, data })
    v.ctx().setText('my note')
    v.ctx().setCheckedHumanCriteria(['c1'])
    await v.select(taskItem(data, 'failed').id)
    expect(v.ctx().text).toBe('')
    await v.select(review.id)
    expect(v.ctx().text).toBe('')
    expect(v.ctx().checkedHumanCriteria).toEqual([])
  })
})

describe('a parent item', () => {
  it('opens parent history with no task load, closing the dock', async () => {
    const epic: EpicActivityItem = {
      id: 'epic-100', type: 'epic_activity', event: 'human_changes_requested', epicId: 'epic-id',
      project: projects[0]!, subject: 'Parent history', preview: 'You requested changes', body: 'You requested changes',
      sender: { name: 'You', role: 'system' }, at: '2026-10-31T12:00:00.000Z',
      taskId: null, taskRef: null, prUrl: null, resolution: 'You requested changes', unread: false
    }
    const v = await mountItem({ selected: taskItem(inbox(), 'failed').id, docked: 'COR-1' })
    vi.mocked(api.tasks.byRef).mockClear()
    v.serve({ needsYou: [], activity: [], resolved: [epic], count: 0 })
    await v.refresh()
    v.flyout.close.mockClear()
    await v.select(epic.id)
    expect(v.item().epicItem.value).toEqual(epic)
    expect(api.tasks.byRef).not.toHaveBeenCalled()
    expect(v.flyout.close).toHaveBeenCalled()
  })

  it('stays on a parent item that leaves the Inbox while open, keeping what was typed', async () => {
    const epic = inbox().needsYou.find(i => i.type === 'epic_review')!
    const v = await mountItem({ selected: epic.id, data: { needsYou: [epic], activity: [], resolved: [], count: 1 } as Inbox })
    expect(v.item().epicGone.value).toBe(false)
    writeDraft(`inbox:${epic.id}`, 'Rename the sheet')
    // The head moved: review restarts, and the next read has no item
    v.serve({ needsYou: [], activity: [], resolved: [], count: 0 })
    await v.refresh()
    expect(v.item().epicItem.value).toMatchObject({ id: epic.id })
    expect(v.item().epicGone.value).toBe(true)
    expect(readDraft(`inbox:${epic.id}`)).toBe('Rename the sheet')
  })
})
