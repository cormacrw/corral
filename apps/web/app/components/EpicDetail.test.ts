// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import type { EpicDetail, Task } from '@corral/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { useProjectLists } from '~/composables/useProjectLists'
import { applyEvent } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import { epics, projects } from '~/prototype/fixtures'
import EpicDetailView from './EpicDetail.vue'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('updates prerequisite and blocks progress and the waiting alert from task events alone', async () => {
  const client = testQueryClient()
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false, gcTime: Infinity } })
  const project = projects[0]!
  const own: EpicDetail = { ...epics[0]!, id: 'own', projectId: project.id, title: 'Current epic', reviewMode: 'direct', branch: null, prNumber: null, reviewState: null, dependsOn: ['pre'], blocks: ['next'], tasks: [] }
  const prerequisite = { ...own, id: 'pre', title: 'Prerequisite', taskCount: 1, mergedCount: 0 }
  const blocked = { ...own, id: 'next', title: 'Follow-up', taskCount: 1, mergedCount: 0 }
  const task = (over: Partial<Task> = {}) => ({ id: 't1', number: 1, ref: 'TA-1', projectId: project.id, epicId: 'pre', status: 'ready', type: 'task', ...over }) as Task
  client.setQueryData(keys.projects.list(), [project])
  client.setQueryData(keys.tasks.list(project.slug), [task(), task({ id: 't2', ref: 'TA-2', epicId: 'next', type: 'design' })])
  client.setQueryData(keys.epics.list(project.slug), [own, prerequisite, blocked])
  vi.spyOn(api.epics, 'get').mockResolvedValue(own)
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
      components: { UAlert: Alert, NuxtLink: Link },
      stubs: {
        UButton: true, UIcon: true, UBadge: true, UTextarea: true,
        UBreadcrumb: true, USelect: true, UTabs: true, AsyncEpicGraph: true, MarkdownText: true,
        TaskTypeBadge: true
      }
    }
  })
  try {
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Waiting on Prerequisite')
    expect(wrapper.get('a[href="/epics/pre"]').text()).toBe('Prerequisite · 0/1 done')
    expect(wrapper.get('a[href="/epics/next"]').text()).toBe('Follow-up · 0/1 done')

    applyEvent(client, { type: 'task.updated', task: task({ status: 'merged' }) })
    applyEvent(client, { type: 'task.updated', task: task({ id: 't2', ref: 'TA-2', epicId: 'next', type: 'design', status: 'approved' }) })
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('a[href="/epics/pre"]').text()).toBe('Prerequisite · 1/1 done')
    expect(wrapper.get('a[href="/epics/next"]').text()).toBe('Follow-up · 1/1 done')

    applyEvent(client, { type: 'task.created', task: task({ id: 't3', ref: 'TA-3' }) })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Waiting on Prerequisite')
    expect(wrapper.get('a[href="/epics/pre"]').text()).toBe('Prerequisite · 1/2 done')

    applyEvent(client, { type: 'task.deleted', projectId: project.id, taskId: 't3' })
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('a[href="/epics/pre"]').text()).toBe('Prerequisite · 1/1 done')
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
  const own: EpicDetail = { ...epics[0]!, id: 'own', projectId: project.id, reviewMode: 'direct', branch: null, prNumber: null, reviewState: null, dependsOn: [], blocks: [], tasks: [task()] }
  client.setQueryData(keys.projects.list(), [project])
  client.setQueryData(keys.tasks.list(project.slug), [task()])
  client.setQueryData(keys.epics.list(project.slug), [own])
  client.setQueryData(keys.epics.detail('own'), own)
  const get = vi.spyOn(api.epics, 'get').mockImplementation(async () => client.getQueryData<EpicDetail>(keys.epics.detail('own'))!)
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
      stubs: { UButton: true, UIcon: true, UBadge: true, UAlert: true, UTextarea: true, UBreadcrumb: true, USelect: true, UTabs: true, AsyncEpicGraph: true, MarkdownText: true, NuxtLink: true }
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

async function mountEpic(mode: 'flyout' | 'page' | 'mobile') {
  const client = testQueryClient()
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false, gcTime: Infinity } })
  const project = projects[0]!
  const own = { ...epics[0]!, id: 'own', projectId: project.id, reviewMode: 'direct', branch: null, prNumber: null, reviewState: null, dependsOn: [], blocks: [], tasks: [] } as unknown as EpicDetail
  client.setQueryData(keys.projects.list(), [project])
  client.setQueryData(keys.tasks.list(project.slug), [])
  client.setQueryData(keys.epics.list(project.slug), [own])
  client.setQueryData(keys.epics.detail('own'), own)
  for (const name of ['ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useLocalStorage', (_key: string, initial: unknown) => vue.ref(initial))
  vi.stubGlobal('useProjectLists', useProjectLists)
  vi.stubGlobal('useLive', () => ({ state: vue.ref({ projects: [project] }) }))
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null), canGoBack: vue.ref(false) }))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  const wrapper = mount(EpicDetailView, {
    props: { epicId: 'own', mode },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: client }]],
      stubs: { UButton: true, UIcon: true, UBadge: true, UAlert: true, UTextarea: true, UBreadcrumb: true, USelect: true, UTabs: true, UTooltip: true, AsyncEpicGraph: true, MarkdownText: true, NuxtLink: true }
    }
  })
  await flushPromises()
  return wrapper
}

it('keeps the description editor open when saving fails', async () => {
  const patch = vi.spyOn(api.epics, 'patch').mockRejectedValue(new Error('Conflict'))
  const wrapper = await mountEpic('page')
  const view = wrapper.vm as unknown as { startEditDescription: () => void, saveDescription: () => Promise<void>, editingDescription: boolean }
  view.startEditDescription()
  await view.saveDescription()
  expect(patch).toHaveBeenCalledOnce()
  expect(view.editingDescription).toBe(true)
  wrapper.unmount()
})

it.each(['flyout', 'mobile'] as const)('never squeezes the tasks in the %s\'s one scroll', async (mode) => {
  const wrapper = await mountEpic(mode)
  const tasks = wrapper.findAll('section').at(-1)!
  expect(tasks.classes()).toContain('shrink-0')
  expect(tasks.classes()).not.toContain('min-h-0')
  wrapper.unmount()
})
