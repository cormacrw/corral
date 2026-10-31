// @vitest-environment happy-dom
import type { Project } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h, reactive, ref, watch } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import Settings from './settings.vue'
import ProjectThumbnail from '~/components/ProjectThumbnail.vue'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'

const { setThumbnail, clearThumbnail, list, patch } = vi.hoisted(() => ({ setThumbnail: vi.fn(), clearThumbnail: vi.fn(), list: vi.fn(), patch: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ api: { projects: { setThumbnail, clearThumbnail, list, patch } }, ApiError: class extends Error {} }))
const add = vi.fn()
const original = { id: 'p1', slug: 'test-app', name: 'Test app', prefix: 'TA', thumbnailColor: '#64748b', thumbnailUrl: null, defaultBranch: 'main', mergeMethod: 'squash', requiredChecks: [], humanReviewDefault: false, epicReviewModeDefault: 'epic', reviewRoundCap: 5, failedRunCap: 3 } as unknown as Project
const Button = defineComponent({ props: ['label', 'disabled'], setup: (props, { attrs }) => () => h('button', { ...attrs, disabled: props.disabled }, props.label) })
const Container = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
// The server's list, as the shell's query reads it
const projects = ref<Project[]>([])
function setup() {
  projects.value = [{ ...original }]
  list.mockImplementation(async () => projects.value)
  const client = testQueryClient()
  client.setQueryData(keys.projects.list(), projects.value)
  for (const [name, value] of Object.entries({ ref, reactive, computed, watch, useRoute: () => ({ params: { slug: 'test-app' } }), useDevice: () => ({ isMobile: ref(false) }), useRemovingProject: () => ref(null), useLive: () => ({ forgetProject: vi.fn() }), useRouter: () => ({ push: vi.fn() }), useToast: () => ({ add }), useSeoMeta: () => {} })) vi.stubGlobal(name, value)
  const wrapper = mount(Settings, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { ProjectThumbnail, UButton: Button, UDashboardPanel: Container, UCard: Container }, stubs: { UInput: true, UInputNumber: true, UFormField: true, USelectMenu: true, USwitch: true, UModal: true, UIcon: true } } })
  async function choose(file: File) {
    const input = wrapper.get('input[type=file]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()
  }
  return { wrapper, client, choose }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it('rejects invalid files before uploading', async () => {
  const { choose, client } = setup()
  await choose(new File(['pdf'], 'file.pdf', { type: 'application/pdf' }))
  expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'error', description: expect.stringContaining('PNG') }))
  await choose(new File([new Uint8Array(3 * 1024 * 1024)], 'large.png', { type: 'image/png' }))
  expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'error', description: 'The image is over 2 MB.' }))
  expect(setThumbnail).not.toHaveBeenCalled()
  expect(client.getQueryData<Project[]>(keys.projects.list())![0]!.thumbnailUrl).toBeNull()
})
it('shows pending state, updates shared thumbnails, and keeps colour edits through image writes', async () => {
  let finish!: (p: Project) => void
  setThumbnail.mockReturnValue(new Promise<Project>((resolve) => {
    finish = (p) => {
      projects.value = [p]
      resolve(p)
    }
  }))
  clearThumbnail.mockImplementation(async () => {
    projects.value = [original]
    return original
  })
  const { wrapper, client, choose } = setup()
  expect(wrapper.text()).not.toContain('Remove image')
  const file = new File(['png'], 'image.png', { type: 'image/png' })
  await choose(file)
  expect(setThumbnail).toHaveBeenCalledWith('test-app', file)
  expect(wrapper.find('[role=status]').exists()).toBe(true)
  await wrapper.get('[role=radio]').trigger('click')
  finish({ ...original, thumbnailUrl: '/new.png' })
  await flushPromises()
  expect(wrapper.find('[role=status]').exists()).toBe(false)
  expect(client.getQueryData<Project[]>(keys.projects.list())![0]!.thumbnailUrl).toBe('/new.png')
  expect(wrapper.get('img').attributes('src')).toBe('/new.png')
  expect(wrapper.get('[role=radio]').attributes('aria-checked')).toBe('true')
  await wrapper.findAll('button').find(b => b.text() === 'Remove image')!.trigger('click')
  await flushPromises()
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('Remove image')
  expect(wrapper.get('[role=radio]').attributes('aria-checked')).toBe('true')
})
it('keeps the previous image and reports the server message after a rejected upload or removal', async () => {
  setThumbnail.mockRejectedValue(new Error('The file is not a PNG image'))
  clearThumbnail.mockRejectedValue(new Error('Could not remove image'))
  const { choose, client, wrapper } = setup()
  await flushPromises()
  projects.value = [{ ...original, thumbnailUrl: '/previous.png' }]
  client.setQueryData(keys.projects.list(), projects.value)
  await flushPromises()
  await choose(new File(['bad'], 'bad.png', { type: 'image/png' }))
  expect(wrapper.get('img').attributes('src')).toBe('/previous.png')
  expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ description: 'The file is not a PNG image', color: 'error' }))
  await wrapper.findAll('button').find(b => b.text() === 'Remove image')!.trigger('click')
  await flushPromises()
  expect(wrapper.get('img').attributes('src')).toBe('/previous.png')
  expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ description: 'Could not remove image', color: 'error' }))
})
it('shows a saved colour in the shared project list as soon as the save ends', async () => {
  patch.mockImplementation(async (_slug: string, input: Partial<Project>) => {
    projects.value = [{ ...original, ...input }]
    return projects.value[0]
  })
  const { wrapper, client } = setup()
  await flushPromises()
  await wrapper.findAll('[role=radio]')[1]!.trigger('click')
  await wrapper.findAll('button').find(b => b.text() === 'Save changes')!.trigger('click')
  await flushPromises()
  expect(patch).toHaveBeenCalledWith('test-app', expect.objectContaining({ name: 'Test app' }))
  expect(client.getQueryData<Project[]>(keys.projects.list())![0]!.thumbnailColor).not.toBe(original.thumbnailColor)
})
