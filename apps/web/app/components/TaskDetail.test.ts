// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import type { Comment, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { projects, tasks } from '~/prototype/fixtures'
import TaskDetail from './TaskDetail.vue'

vi.mock('~/composables/useApi', () => ({
  ApiError: class extends Error {},
  api: {
    tasks: { byRef: vi.fn(), comments: vi.fn(), history: vi.fn(), evidence: vi.fn(), reviews: vi.fn(), patch: vi.fn(), comment: vi.fn(), transition: vi.fn(), resume: vi.fn() },
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

const composer = vue.defineComponent({
  name: 'PromptComposer',
  props: ['modelValue'],
  setup: () => () => vue.h('form')
})

beforeEach(() => {
  for (const name of ['ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount', 'useTemplateRef'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useRoute', () => ({ query: {} }))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.stubGlobal('useTaskFlyout', () => ({ close: vi.fn(), open: vi.fn() }))
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useLive', () => ({
    state: vue.ref({ projects: [{ ...projects[0]!, id: taskA.projectId }], tasks: {}, epics: {}, agents: [] }),
    subscribe: () => () => {}
  }))
  vi.mocked(api.tasks.byRef).mockImplementation(async ref => ref === 'COR-1' ? taskA : taskB)
  for (const side of [api.tasks.comments, api.tasks.history, api.tasks.evidence, api.tasks.reviews, api.runs.list]) vi.mocked(side).mockResolvedValue([])
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function mountDetail() {
  const wrapper = mount(TaskDetail, {
    props: { taskRef: 'COR-1', mode: 'page' },
    shallow: true,
    global: { components: { PromptComposer: composer }, stubs: { PromptComposer: false, teleport: true } }
  })
  await flushPromises()
  return wrapper
}

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
  await (draft.vm.$attrs['onUpdate:modelValue'] as (text: string) => void)('Draft for B')
  await flushPromises()

  sent.resolve({ id: 'c-a', taskId: 'task-a', body: 'For task A', createdAt: new Date().toISOString() } as unknown as Comment)
  expect(await sending).toBe(true)
  await flushPromises()
  expect(wrapper.getComponent(composer).props('modelValue')).toBe('Draft for B')
  expect(wrapper.text()).not.toContain('For task A')
})
