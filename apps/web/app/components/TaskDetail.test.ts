// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import type { Comment, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { projects, tasks } from '~/prototype/fixtures'
import { applyEvent } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import TaskDetail from './TaskDetail.vue'

vi.mock('~/composables/useApi', () => ({
  ApiError: class extends Error {},
  api: {
    tasks: { byRef: vi.fn(), comments: vi.fn(), history: vi.fn(), evidence: vi.fn(), reviews: vi.fn(), patch: vi.fn(), remove: vi.fn(), comment: vi.fn(), transition: vi.fn(), resume: vi.fn() },
    runs: { list: vi.fn() }
  }
}))

const taskA = { ...tasks[0]!, id: 'task-a', ref: 'COR-1', number: 1, title: 'Task A', status: 'backlog' } as Task
const taskB = { ...taskA, id: 'task-b', ref: 'COR-2', number: 2, title: 'Task B' } as Task

function deferred<T>() {
  let resolve = (_: T) => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tabs = vue.defineComponent({ name: 'UTabs', props: ['modelValue'], setup: () => () => vue.h('nav') })
const composer = vue.defineComponent({
  name: 'DraftComposer',
  props: ['draft'],
  setup: () => () => vue.h('form')
})

beforeEach(() => {
  sessionStorage.clear()
  for (const name of ['ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount', 'useTemplateRef', 'toRaw'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useRoute', () => ({ query: {} }))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.stubGlobal('useTaskFlyout', () => ({ close: vi.fn(), open: vi.fn() }))
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useShell', () => ({ projects: [{ ...projects[0]!, id: taskA.projectId }], agents: [] }))
  vi.stubGlobal('useProjectLists', () => ({ tasks: vue.ref([]), epics: vue.ref([]) }))
  vi.mocked(api.tasks.byRef).mockImplementation(async ref => ref === 'COR-1' ? taskA : taskB)
  for (const side of [api.tasks.comments, api.tasks.history, api.tasks.evidence, api.tasks.reviews, api.runs.list]) vi.mocked(side).mockResolvedValue([])
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function mountDetail(client = testQueryClient()) {
  const wrapper = mount(TaskDetail, {
    props: { taskRef: 'COR-1', mode: 'page' },
    shallow: true,
    global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { DraftComposer: composer, UTabs: tabs }, stubs: { DraftComposer: false, UTabs: false, teleport: true } }
  })
  await flushPromises()
  return wrapper
}

it('opens the next task on the default tab', async () => {
  const wrapper = await mountDetail()
  const activityTabs = () => wrapper.findAllComponents(tabs).at(-1)!
  ;(activityTabs().vm.$attrs['onUpdate:modelValue'] as (tab: string) => void)('evidence')
  await flushPromises()
  expect(activityTabs().props('modelValue')).toBe('evidence')
  await wrapper.setProps({ taskRef: 'COR-2' })
  await flushPromises()
  expect(activityTabs().props('modelValue')).toBe('activity')
})

it('shows a task from a loaded project list while its own entry loads', async () => {
  const client = testQueryClient()
  client.setQueryData(keys.tasks.list('corral'), [taskA])
  vi.mocked(api.tasks.byRef).mockReturnValue(new Promise(() => {}))
  const wrapper = await mountDetail(client)
  expect(wrapper.findComponent({ name: 'USkeleton' }).exists()).toBe(false)
  expect(wrapper.find('u-skeleton-stub').exists()).toBe(false)
  expect(wrapper.html()).toContain(taskA.title)
})

it('drops a save that finishes after moving to another task', async () => {
  const wrapper = await mountDetail()
  const save = deferred<Task>()
  vi.mocked(api.tasks.patch).mockReturnValue(save.promise)
  const title = wrapper.get('[aria-label="Title"]')
  await title.trigger('change')
  await wrapper.setProps({ taskRef: 'COR-2' })
  await flushPromises()

  save.resolve({ ...taskA, title: 'Task A saved' })
  await flushPromises()
  await title.trigger('change')
  expect(api.tasks.patch).toHaveBeenLastCalledWith(expect.anything(), 2, expect.anything())
})

it('leaves the next task\'s comments and draft alone when an older comment lands', async () => {
  const wrapper = await mountDetail()
  const sent = deferred<Comment>()
  vi.mocked(api.tasks.comment).mockReturnValue(sent.promise)
  const submit = wrapper.getComponent(composer).vm.$attrs.onSubmit as (text: string) => Promise<boolean>
  const sending = submit('For task A')
  await wrapper.setProps({ taskRef: 'COR-2' })
  await flushPromises()
  const draft = wrapper.getComponent(composer)
  draft.props('draft').text.value = 'Draft for B'
  await flushPromises()

  sent.resolve({ id: 'c-a', taskId: 'task-a', body: 'For task A', createdAt: new Date().toISOString() } as unknown as Comment)
  expect(await sending).toBe(true)
  await flushPromises()
  expect(wrapper.getComponent(composer).props('draft').text.value).toBe('Draft for B')
  expect(wrapper.text()).not.toContain('For task A')
})

const submitComment = (wrapper: VueWrapper, text: string) => {
  const box = wrapper.getComponent(composer)
  box.props('draft').text.value = text
  return (box.vm.$attrs.onSubmit as (text: string) => Promise<boolean>)(text)
}
const comment = (over: Partial<Comment> = {}) => ({ id: 'c-1', taskId: taskA.id, author: { kind: 'human', userId: 'me' }, body: 'Hello', pinned: false, createdAt: new Date().toISOString(), ...over }) as Comment

it('reopens from cache at once and refetches nothing while the data is fresh', async () => {
  const client = testQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, staleTime: 30_000 } })
  const first = await mountDetail(client)
  first.unmount()
  vi.clearAllMocks()
  const reopened = mount(TaskDetail, {
    props: { taskRef: 'COR-1', mode: 'page' },
    shallow: true,
    global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { DraftComposer: composer, UTabs: tabs }, stubs: { DraftComposer: false, UTabs: false, teleport: true } }
  })
  // Before anything has had a chance to resolve
  expect(reopened.find('[aria-label="Title"]').exists()).toBe(true)
  expect(reopened.findComponent({ name: 'USkeleton' }).exists()).toBe(false)
  await flushPromises()
  expect(api.tasks.byRef).not.toHaveBeenCalled()
  expect(api.tasks.comments).not.toHaveBeenCalled()
})

it('shows an agent\'s comment without refetching history or evidence', async () => {
  const client = testQueryClient()
  await mountDetail(client)
  vi.clearAllMocks()
  const stale = applyEvent(client, { type: 'comment.created', comment: comment({ author: { kind: 'agent', agentId: 'a', runId: 'r', role: 'developer' } as Comment['author'] }) })
  expect(stale).toEqual([])
  await flushPromises()
  expect(client.getQueryData<Comment[]>(keys.tasks.comments('COR-1'))).toHaveLength(1)
  expect(api.tasks.history).not.toHaveBeenCalled()
  expect(api.tasks.evidence).not.toHaveBeenCalled()
})

it('shows a posted comment and empties the box before the server answers', async () => {
  const client = testQueryClient()
  const wrapper = await mountDetail(client)
  const sent = deferred<Comment>()
  vi.mocked(api.tasks.comment).mockReturnValue(sent.promise)
  const sending = submitComment(wrapper, 'Hello')
  await flushPromises()
  expect(client.getQueryData<Comment[]>(keys.tasks.comments('COR-1'))?.map(c => c.body)).toEqual(['Hello'])
  expect(wrapper.getComponent(composer).props('draft').text.value).toBe('')

  // The event can beat the response; only one comment ever stays
  applyEvent(client, { type: 'comment.created', comment: comment() })
  vi.mocked(api.tasks.comments).mockResolvedValue([comment()])
  sent.resolve(comment())
  expect(await sending).toBe(true)
  await flushPromises()
  expect(client.getQueryData<Comment[]>(keys.tasks.comments('COR-1'))?.map(c => c.id)).toEqual(['c-1'])
})

it('removes a comment whose post failed and puts its draft back', async () => {
  const client = testQueryClient()
  const wrapper = await mountDetail(client)
  vi.mocked(api.tasks.comment).mockRejectedValue(new Error('Offline'))
  expect(await submitComment(wrapper, 'Keep me')).toBe(false)
  await flushPromises()
  expect(client.getQueryData(keys.tasks.comments('COR-1'))).toEqual([])
  expect(wrapper.getComponent(composer).props('draft').text.value).toBe('Keep me')
})

it('keeps a failed comment\'s draft for when you return to its task', async () => {
  const wrapper = await mountDetail()
  const sent = deferred<Comment>()
  vi.mocked(api.tasks.comment).mockReturnValue(sent.promise.then(() => {
    throw new Error('Offline')
  }))
  const sending = submitComment(wrapper, 'For task A')
  await flushPromises()
  await wrapper.setProps({ taskRef: 'COR-2' })
  await flushPromises()
  sent.resolve(comment())
  expect(await sending).toBe(false)
  await flushPromises()
  expect(wrapper.getComponent(composer).props('draft').text.value).toBe('')
  await wrapper.setProps({ taskRef: 'COR-1' })
  await flushPromises()
  expect(wrapper.getComponent(composer).props('draft').text.value).toBe('For task A')
})

it('shows a resume in the open task from its response', async () => {
  const client = testQueryClient()
  vi.mocked(api.tasks.byRef).mockResolvedValue({ ...taskA, paused: true })
  const wrapper = await mountDetail(client)
  const resumed = { ...taskA, paused: false }
  vi.mocked(api.tasks.resume).mockResolvedValue(resumed)
  vi.mocked(api.tasks.byRef).mockResolvedValue(resumed)
  await wrapper.get('[data-testid="task-paused"] ubutton').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-testid="task-paused"]').exists()).toBe(false)
})

describe('a save that fails', () => {
  it('keeps the description editor open', async () => {
    const wrapper = await mountDetail()
    const view = wrapper.vm as unknown as { startEditDescription: () => void, saveDescription: () => Promise<void>, editingDescription: boolean }
    view.startEditDescription()
    vi.mocked(api.tasks.patch).mockRejectedValue(new Error('Conflict'))
    await view.saveDescription()
    expect(view.editingDescription).toBe(true)
    vi.mocked(api.tasks.patch).mockResolvedValue(taskA)
    await view.saveDescription()
    expect(view.editingDescription).toBe(false)
  })

  it('keeps a new criterion\'s text', async () => {
    const wrapper = await mountDetail()
    const view = wrapper.vm as unknown as { addCriterion: () => Promise<void>, newCriterion: string }
    view.newCriterion = 'It works'
    vi.mocked(api.tasks.patch).mockRejectedValue(new Error('Conflict'))
    await view.addCriterion()
    expect(view.newCriterion).toBe('It works')
    vi.mocked(api.tasks.patch).mockResolvedValue(taskA)
    await view.addCriterion()
    expect(view.newCriterion).toBe('')
  })
})

it('links a dependency to its own page where there is no flyout', async () => {
  vi.mocked(api.tasks.byRef).mockImplementation(async ref => ref === 'COR-1' ? { ...taskA, dependsOn: ['COR-2'] } : taskB)
  const wrapper = await mountDetail()
  expect(wrapper.find('[to="/tasks/COR-2"]').exists()).toBe(true)
})

it('asks once however often Delete is pressed', async () => {
  const wrapper = await mountDetail()
  const removing = deferred<undefined>()
  vi.mocked(api.tasks.remove).mockReturnValue(removing.promise as never)
  const view = wrapper.vm as unknown as { remove: () => Promise<void> }
  void view.remove()
  await flushPromises()
  await view.remove()
  expect(api.tasks.remove).toHaveBeenCalledOnce()
  removing.resolve(undefined)
  await flushPromises()
})
