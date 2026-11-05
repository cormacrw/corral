// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { enableAutoUnmount, flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import type { Comment, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { projects, tasks } from '~/prototype/fixtures'
import { applyEvent } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import TaskActivity from '~/features/activity/components/TaskActivity.vue'
import TaskActivityFeed from '~/features/activity/components/TaskActivityFeed.vue'
import DetailLoading from '~/features/tasks/components/DetailLoading.vue'
import DraftComposer from '~/features/tasks/components/DraftComposer.vue'
import TaskCriteria from '~/features/tasks/components/TaskCriteria.vue'
import TaskDeleteSection from '~/features/tasks/components/TaskDeleteSection.vue'
import TaskDependencies from '~/features/tasks/components/TaskDependencies.vue'
import TaskDescriptionField from '~/features/tasks/components/TaskDescriptionField.vue'
import TaskDetail from '~/features/tasks/components/TaskDetail.vue'
import TaskStatusNotices from '~/features/tasks/components/TaskStatusNotices.vue'

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

// Stand-ins for the shared UI kit, with the controls a person uses
const { defineComponent, h } = vue
const value = (e: Event) => (e.target as HTMLInputElement).value
const AppButton = defineComponent({
  inheritAttrs: false,
  props: ['label', 'disabled', 'loading', 'type'],
  setup: (props, { attrs, slots }) => () => h('button', { ...attrs, type: props.type ?? 'button', disabled: props.disabled }, props.label ?? slots.default?.())
})
const AppInput = defineComponent({
  props: ['modelValue', 'placeholder'],
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('input', { placeholder: props.placeholder, value: props.modelValue, onInput: (e: Event) => emit('update:modelValue', value(e)) })
})
const AppTabs = defineComponent({
  props: ['modelValue', 'items'],
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('div', (props.items as { label: string, value: string }[]).map(item =>
    h('button', { role: 'tab', onClick: () => emit('update:modelValue', item.value) }, item.label)))
})
const AppModal = defineComponent({
  props: ['open'],
  setup: (props, { slots }) => () => props.open ? h('div', { role: 'dialog' }, [slots.body?.(), slots.footer?.()]) : null
})
const PromptComposer = defineComponent({
  props: { modelValue: { type: String, default: '' }, onSubmit: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('form', { onSubmit: (e: Event) => {
    e.preventDefault()
    void props.onSubmit?.(props.modelValue)
  } }, [h('textarea', { 'aria-label': 'Comment', 'value': props.modelValue, 'onInput': (e: Event) => emit('update:modelValue', value(e)) })])
})
const MarkdownText = defineComponent({ props: ['text'], setup: props => () => h('p', props.text) })
const AsyncTaskDescription = defineComponent({ setup: () => () => h('div', { 'data-testid': 'description-editor' }) })
const UiSkeleton = defineComponent({ name: 'UiSkeleton', setup: () => () => h('div') })

// The detail's own parts render; everything they're built from stays an inert tag
const components = {
  TaskActivity, TaskActivityFeed, TaskCriteria, TaskDeleteSection, TaskDependencies, TaskDescriptionField, TaskStatusNotices, DetailLoading, DraftComposer,
  AppButton, AppInput, AppTabs, AppModal, PromptComposer, MarkdownText, AsyncTaskDescription, UiSkeleton
}
const stubs = { TimeAgo: true, CriterionMetIcon: true, AuditActivity: true, teleport: true }

enableAutoUnmount(afterEach)
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
  vi.resetAllMocks()
})

function mountDetail(client = testQueryClient()) {
  return mount(TaskDetail, {
    props: { taskRef: 'COR-1', mode: 'page' },
    global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components, stubs }
  })
}
async function mounted(client = testQueryClient()) {
  const wrapper = mountDetail(client)
  await flushPromises()
  return wrapper
}

const box = (wrapper: VueWrapper) => wrapper.find<HTMLTextAreaElement>('textarea[aria-label="Comment"]')
async function submitComment(wrapper: VueWrapper, text: string) {
  await box(wrapper).setValue(text)
  await box(wrapper).element.form!.dispatchEvent(new Event('submit', { cancelable: true }))
  await flushPromises()
}
const button = (root: VueWrapper | Pick<DOMWrapper<Element>, 'findAll'>, label: string) => root.findAll('button').find(b => b.text() === label)!
const comment = (over: Partial<Comment> = {}) => ({ id: 'c-1', taskId: taskA.id, author: { kind: 'human', userId: 'me' }, body: 'Hello', pinned: false, createdAt: new Date().toISOString(), ...over }) as Comment
const switchTo = async (wrapper: VueWrapper, taskRef: string) => {
  await wrapper.setProps({ taskRef })
  await flushPromises()
}

it('opens the next task on the default tab', async () => {
  const wrapper = await mounted()
  await wrapper.findAll('[role="tab"]').find(t => t.text().startsWith('Evidence'))!.trigger('click')
  expect(box(wrapper).exists()).toBe(false)
  await switchTo(wrapper, 'COR-2')
  expect(box(wrapper).exists()).toBe(true)
})

it('shows a task from a loaded project list while its own entry loads', async () => {
  vi.mocked(api.tasks.byRef).mockReturnValue(new Promise(() => {}))
  const loading = await mounted()
  expect(loading.findComponent(DetailLoading).exists()).toBe(true)

  const client = testQueryClient()
  client.setQueryData(keys.tasks.list('corral'), [taskA])
  const wrapper = await mounted(client)
  expect(wrapper.findComponent(DetailLoading).exists()).toBe(false)
  expect(wrapper.get<HTMLInputElement>('[aria-label="Title"]').element.value).toBe(taskA.title)
})

it('drops a save that finishes after moving to another task', async () => {
  const wrapper = await mounted()
  const save = deferred<Task>()
  vi.mocked(api.tasks.patch).mockReturnValue(save.promise)
  const title = wrapper.get('[aria-label="Title"]')
  await title.trigger('change')
  await switchTo(wrapper, 'COR-2')

  save.resolve({ ...taskA, title: 'Task A saved' })
  await flushPromises()
  expect(wrapper.get<HTMLInputElement>('[aria-label="Title"]').element.value).toBe('Task B')
  await title.trigger('change')
  expect(api.tasks.patch).toHaveBeenLastCalledWith(expect.anything(), 2, expect.anything())
})

it('leaves the next task\'s comments and draft alone when an older comment lands', async () => {
  const wrapper = await mounted()
  const sent = deferred<Comment>()
  vi.mocked(api.tasks.comment).mockReturnValue(sent.promise)
  await submitComment(wrapper, 'For task A')
  await switchTo(wrapper, 'COR-2')
  await box(wrapper).setValue('Draft for B')

  sent.resolve(comment({ id: 'c-a', body: 'For task A' }))
  await flushPromises()
  expect(box(wrapper).element.value).toBe('Draft for B')
  expect(wrapper.text()).not.toContain('For task A')
})

it('reopens from cache at once and refetches nothing while the data is fresh', async () => {
  const client = testQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, staleTime: 30_000 } })
  const first = await mounted(client)
  first.unmount()
  vi.clearAllMocks()
  const reopened = mountDetail(client)
  // Before anything has had a chance to resolve
  expect(reopened.find('[aria-label="Title"]').exists()).toBe(true)
  expect(reopened.findComponent(DetailLoading).exists()).toBe(false)
  await flushPromises()
  expect(api.tasks.byRef).not.toHaveBeenCalled()
  expect(api.tasks.comments).not.toHaveBeenCalled()
})

it('shows an agent\'s comment without refetching history or evidence', async () => {
  const client = testQueryClient()
  const wrapper = await mounted(client)
  vi.clearAllMocks()
  applyEvent(client, { type: 'comment.created', comment: comment({ body: 'From the agent', author: { kind: 'agent', agentId: 'a', runId: 'r', role: 'developer' } as Comment['author'] }) })
  await flushPromises()
  expect(wrapper.text()).toContain('From the agent')
  expect(api.tasks.history).not.toHaveBeenCalled()
  expect(api.tasks.evidence).not.toHaveBeenCalled()
})

it('shows a posted comment and empties the box before the server answers', async () => {
  const client = testQueryClient()
  const wrapper = await mounted(client)
  const sent = deferred<Comment>()
  vi.mocked(api.tasks.comment).mockReturnValue(sent.promise)
  await submitComment(wrapper, 'Hello')
  expect(wrapper.text()).toContain('Hello')
  expect(box(wrapper).element.value).toBe('')

  // The event can beat the response; only one comment ever stays
  applyEvent(client, { type: 'comment.created', comment: comment() })
  vi.mocked(api.tasks.comments).mockResolvedValue([comment()])
  sent.resolve(comment())
  await flushPromises()
  expect(client.getQueryData<Comment[]>(keys.tasks.comments('COR-1'))?.map(c => c.id)).toEqual(['c-1'])
})

it('removes a comment whose post failed and puts its draft back', async () => {
  const wrapper = await mounted()
  vi.mocked(api.tasks.comment).mockRejectedValue(new Error('Offline'))
  await submitComment(wrapper, 'Keep me')
  expect(wrapper.findAllComponents(MarkdownText).some(c => c.text() === 'Keep me')).toBe(false)
  expect(box(wrapper).element.value).toBe('Keep me')
})

it('keeps a failed comment\'s draft for when you return to its task', async () => {
  const wrapper = await mounted()
  const sent = deferred<Comment>()
  vi.mocked(api.tasks.comment).mockReturnValue(sent.promise.then(() => {
    throw new Error('Offline')
  }))
  await submitComment(wrapper, 'For task A')
  await switchTo(wrapper, 'COR-2')
  sent.resolve(comment())
  await flushPromises()
  expect(box(wrapper).element.value).toBe('')
  await switchTo(wrapper, 'COR-1')
  expect(box(wrapper).element.value).toBe('For task A')
})

it('shows a resume in the open task from its response', async () => {
  vi.mocked(api.tasks.byRef).mockResolvedValue({ ...taskA, paused: true })
  const wrapper = await mounted()
  const resumed = { ...taskA, paused: false }
  vi.mocked(api.tasks.resume).mockResolvedValue(resumed)
  vi.mocked(api.tasks.byRef).mockResolvedValue(resumed)
  await button(wrapper.get('[data-testid="task-paused"]'), 'Resume').trigger('click')
  await flushPromises()
  expect(api.tasks.resume).toHaveBeenCalledOnce()
  expect(wrapper.find('[data-testid="task-paused"]').exists()).toBe(false)
})

describe('a save that fails', () => {
  it('keeps the description editor open', async () => {
    const wrapper = await mounted()
    await wrapper.get('[aria-label="Edit description"]').trigger('click')
    const editor = () => wrapper.find('[data-testid="description-editor"]')
    expect(editor().exists()).toBe(true)
    vi.mocked(api.tasks.patch).mockRejectedValue(new Error('Conflict'))
    await button(wrapper, 'Save').trigger('click')
    await flushPromises()
    expect(editor().exists()).toBe(true)
    vi.mocked(api.tasks.patch).mockResolvedValue(taskA)
    await button(wrapper, 'Save').trigger('click')
    await flushPromises()
    expect(editor().exists()).toBe(false)
  })

  it('keeps a new criterion\'s text', async () => {
    const wrapper = await mounted()
    const input = () => wrapper.get<HTMLInputElement>('input[placeholder="Add criterion"]')
    await input().setValue('It works')
    vi.mocked(api.tasks.patch).mockRejectedValue(new Error('Conflict'))
    await input().element.form!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    expect(api.tasks.patch).toHaveBeenCalledWith(expect.anything(), 1, expect.objectContaining({ acceptanceCriteria: expect.arrayContaining([{ text: 'It works' }]) }))
    expect(input().element.value).toBe('It works')
    vi.mocked(api.tasks.patch).mockResolvedValue(taskA)
    await input().element.form!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    expect(input().element.value).toBe('')
  })
})

it('deletes once however often Delete is pressed', async () => {
  const wrapper = await mounted()
  const removing = deferred<undefined>()
  vi.mocked(api.tasks.remove).mockReturnValue(removing.promise as never)
  await button(wrapper, 'Delete task').trigger('click')
  const dialog = wrapper.get('[role="dialog"]')
  await button(dialog, 'Delete').trigger('click')
  await flushPromises()
  await button(dialog, 'Delete').trigger('click')
  expect(api.tasks.remove).toHaveBeenCalledOnce()
  removing.resolve(undefined)
  await flushPromises()
})
