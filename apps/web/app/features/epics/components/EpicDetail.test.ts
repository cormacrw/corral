// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import type { EpicDetail, Task } from '@corral/contracts'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { useProjectLists } from '~/features/projects/composables/useProjectLists'
import { applyEvent } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import { epics, projects } from '~/prototype/fixtures'
import EpicDetailView from '~/features/epics/components/EpicDetail.vue'

enableAutoUnmount(afterEach)
beforeEach(() => {
  // The parent task's history joins the epic's activity
  vi.spyOn(api.tasks, 'history').mockResolvedValue([])
  // Anything else unmocked fails at once rather than reaching the network
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unmocked request'))))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('updates prerequisite and blocks progress and the waiting alert from task events alone', async () => {
  const client = testQueryClient()
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false, gcTime: Infinity } })
  const project = projects[0]!
  const own: EpicDetail = { ...epics[0]!, id: 'own', projectId: project.id, title: 'Current epic', reviewMode: 'direct', branch: null, prNumber: null, reviewState: null, dependsOn: ['pre'], blocks: ['next'], tasks: [], fixes: [] }
  const prerequisite = { ...own, id: 'pre', title: 'Prerequisite', taskCount: 1, mergedCount: 0 }
  const blocked = { ...own, id: 'next', title: 'Follow-up', taskCount: 1, mergedCount: 0 }
  const task = (over: Partial<Task> = {}) => ({ id: 't1', number: 1, ref: 'TA-1', projectId: project.id, epicId: 'pre', status: 'ready', type: 'task', ...over }) as Task
  client.setQueryData(keys.projects.list(), [project])
  client.setQueryData(keys.tasks.list(project.slug), [task(), task({ id: 't2', ref: 'TA-2', epicId: 'next', type: 'design' })])
  client.setQueryData(keys.epics.list(project.slug), [own, prerequisite, blocked])
  vi.spyOn(api.epics, 'get').mockResolvedValue(own)
  vi.spyOn(api.epics, 'history').mockResolvedValue([])
  vi.spyOn(api.epics, 'activity').mockResolvedValue([])
  const list = vi.spyOn(api.epics, 'list')
  for (const name of ['ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useLocalStorage', (_key: string, initial: unknown) => vue.ref(initial))
  vi.stubGlobal('useProjectLists', useProjectLists)
  vi.stubGlobal('useShell', () => ({ projects: [project] }))
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null) }))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  const Alert = vue.defineComponent({
    props: ['title'],
    setup: props => () => vue.h('div', { role: 'alert' }, props.title)
  })
  const Link = vue.defineComponent({
    props: ['to'],
    setup: (props, { slots }) => () => vue.h('a', { href: props.to }, slots.default?.())
  })
  const wrapper = mount(EpicDetailView, {
    props: { epicId: own.id, mode: 'page' },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: client }]],
      components: { AppAlert: Alert, NuxtLink: Link },
      stubs: {
        AppButton: true, Icon: true, AppBadge: true, AppTextarea: true,
        AppBreadcrumb: true, AppSelect: true, AppTabs: true, AsyncEpicGraph: true, MarkdownText: true,
        TaskTypeBadge: true
      }
    }
  })
  try {
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Prerequisite')
    expect(wrapper.get('a[href="/epics/pre"]').text()).toContain('0/1')
    expect(wrapper.get('a[href="/epics/next"]').text()).toContain('0/1')

    applyEvent(client, { type: 'task.updated', task: task({ status: 'merged' }) })
    applyEvent(client, { type: 'task.updated', task: task({ id: 't2', ref: 'TA-2', epicId: 'next', type: 'design', status: 'approved' }) })
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('a[href="/epics/pre"]').text()).toContain('1/1')
    expect(wrapper.get('a[href="/epics/next"]').text()).toContain('1/1')

    applyEvent(client, { type: 'task.created', task: task({ id: 't3', ref: 'TA-3' }) })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Prerequisite')
    expect(wrapper.get('a[href="/epics/pre"]').text()).toContain('1/2')

    applyEvent(client, { type: 'task.deleted', projectId: project.id, taskId: 't3' })
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('a[href="/epics/pre"]').text()).toContain('1/1')
    // The cached epic aggregates deliberately remain stale; the UI reads tasks.
    expect(client.getQueryData<typeof epics>(keys.epics.list(project.slug))?.find(e => e.id === 'pre')?.mergedCount).toBe(0)
    expect(list).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
    client.clear()
  }
})

it('keeps an open epic\'s task list live as its tasks change, join and leave', async () => {
  const client = testQueryClient()
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false, gcTime: Infinity } })
  const project = projects[0]!
  const task = (over: Partial<Task> = {}) => ({ id: 't1', number: 1, ref: 'TA-1', title: 'First', projectId: project.id, epicId: 'own', status: 'ready', type: 'task', priority: 'medium', dependsOn: [], ...over }) as Task
  const own: EpicDetail = { ...epics[0]!, id: 'own', projectId: project.id, reviewMode: 'direct', branch: null, prNumber: null, reviewState: null, dependsOn: [], blocks: [], tasks: [task()], fixes: [] }
  client.setQueryData(keys.projects.list(), [project])
  client.setQueryData(keys.tasks.list(project.slug), [task()])
  client.setQueryData(keys.epics.list(project.slug), [own])
  client.setQueryData(keys.epics.detail('own'), own)
  const get = vi.spyOn(api.epics, 'get').mockImplementation(async () => client.getQueryData<EpicDetail>(keys.epics.detail('own'))!)
  vi.spyOn(api.epics, 'history').mockResolvedValue([])
  vi.spyOn(api.epics, 'activity').mockResolvedValue([])
  for (const name of ['ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useLocalStorage', (_key: string, initial: unknown) => vue.ref(initial))
  vi.stubGlobal('useProjectLists', useProjectLists)
  vi.stubGlobal('useShell', () => ({ projects: [project] }))
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null) }))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  const Badge = vue.defineComponent({ props: ['status'], setup: props => () => vue.h('i', { 'data-testid': 'status' }, props.status) })
  const wrapper = mount(EpicDetailView, {
    props: { epicId: 'own', mode: 'page' },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: client }]],
      components: { StatusBadge: Badge },
      stubs: { AppButton: true, Icon: true, AppBadge: true, AppAlert: true, AppTextarea: true, AppBreadcrumb: true, AppSelect: true, AppTabs: true, AsyncEpicGraph: true, MarkdownText: true, NuxtLink: true }
    }
  })
  const statuses = () => wrapper.findAll('li [data-testid="status"]').map(s => s.text())
  try {
    await flushPromises()
    expect(statuses()).toEqual(['ready'])

    const stale = applyEvent(client, { type: 'task.updated', task: task({ status: 'in_progress' }) })
    await flushPromises()
    expect(statuses()).toEqual(['in_progress'])
    expect(get).not.toHaveBeenCalled()
    expect(stale).toContainEqual(keys.epics.detail('own'))

    applyEvent(client, { type: 'task.created', task: task({ id: 't2', ref: 'TA-2', status: 'backlog' }) })
    await flushPromises()
    expect(statuses()).toEqual(['in_progress', 'backlog'])

    // Leaving the epic carries no epic ID for it, so the epic is found by its tasks
    const left = applyEvent(client, { type: 'task.updated', task: task({ id: 't2', ref: 'TA-2', epicId: null, status: 'backlog' }) })
    await flushPromises()
    expect(statuses()).toEqual(['in_progress'])
    expect(left).toContainEqual(keys.epics.detail('own'))
  } finally {
    wrapper.unmount()
    client.clear()
  }
})

// The page with its epic cached, and every request it makes mocked
async function mountEpic({ tab = 'tasks', activity = async () => [] as never[] }: { tab?: string, activity?: () => Promise<never[]> } = {}) {
  const client = testQueryClient()
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false, gcTime: Infinity } })
  const project = projects[0]!
  const own = { ...epics[0]!, id: 'own', projectId: project.id, reviewMode: 'direct', branch: null, prNumber: null, reviewState: null, dependsOn: [], blocks: [], tasks: [] } as unknown as EpicDetail
  client.setQueryData(keys.projects.list(), [project])
  client.setQueryData(keys.tasks.list(project.slug), [])
  client.setQueryData(keys.epics.list(project.slug), [own])
  client.setQueryData(keys.epics.detail('own'), own)
  vi.spyOn(api.epics, 'get').mockResolvedValue(own)
  vi.spyOn(api.epics, 'history').mockResolvedValue([])
  vi.spyOn(api.epics, 'activity').mockImplementation(activity)
  for (const name of ['ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useLocalStorage', (key: string, initial: unknown) => vue.ref(key === 'corral.epic.tab' ? tab : initial))
  vi.stubGlobal('useShell', () => ({ projects: [project] }))
  vi.stubGlobal('useProjectLists', useProjectLists)
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null), canGoBack: vue.ref(false) }))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  const AppButton = vue.defineComponent({ props: ['label'], setup: props => () => vue.h('button', props.label) })
  const wrapper = mount(EpicDetailView, {
    props: { epicId: 'own', mode: 'page' },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: client }]],
      components: { AppButton },
      stubs: { Icon: true, AppBadge: true, AppAlert: true, AppLoadError: { props: ['title'], template: '<p role="alert">{{ title }}</p>' }, AppTextarea: true, AppBreadcrumb: true, AppSelect: true, AppTabs: true, AppTooltip: true, AsyncEpicGraph: true, MarkdownText: true, NuxtLink: true }
    }
  })
  await flushPromises()
  return { wrapper, own, button: (label: string) => wrapper.findAll('button').find(b => b.text() === label) }
}

it('keeps the description editor open when saving fails', async () => {
  const patch = vi.spyOn(api.epics, 'patch').mockRejectedValue(new Error('Conflict'))
  const { wrapper, button } = await mountEpic()
  await wrapper.get('[aria-label="Edit description"]').trigger('click')
  await button('Save')!.trigger('click')
  await flushPromises()
  expect(patch).toHaveBeenCalledOnce()
  expect(button('Save')).toBeDefined()
})

it('keeps the epic page when only its activity can\'t load', async () => {
  const { wrapper, own } = await mountEpic({ tab: 'activity', activity: () => Promise.reject(new Error('Down')) })
  expect((wrapper.get('[aria-label="Task title"]').element as HTMLInputElement).value).toBe(own.title)
  expect(wrapper.findAll('[role="alert"]').map(a => a.text())).toEqual(['Couldn\'t load the activity.'])
})
