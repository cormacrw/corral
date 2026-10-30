// @vitest-environment happy-dom
import type { Project } from '@corral/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h, reactive, ref, watch } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import Settings from './settings.vue'
import ProjectThumbnail from '~/components/ProjectThumbnail.vue'

const { setThumbnail, clearThumbnail } = vi.hoisted(() => ({ setThumbnail: vi.fn(), clearThumbnail: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ api: { projects: { setThumbnail, clearThumbnail } }, ApiError: class extends Error {} }))
const add = vi.fn()
const original = { id: 'p1', slug: 'test-app', name: 'Test app', prefix: 'TA', thumbnailColor: '#64748b', thumbnailUrl: null, defaultBranch: 'main', mergeMethod: 'squash', requiredChecks: [], humanReviewDefault: false, epicReviewModeDefault: 'epic', reviewRoundCap: 5, failedRunCap: 3 } as unknown as Project
const Button = defineComponent({ props: ['label', 'disabled'], setup: (props, { attrs }) => () => h('button', { ...attrs, disabled: props.disabled }, props.label) })
const Container = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
function setup() {
  const state = ref({ projects: [{ ...original }] })
  for (const [name, value] of Object.entries({ ref, reactive, computed, watch, useRoute: () => ({ params: { slug: 'test-app' } }), useDevice: () => ({ isMobile: ref(false) }), useLive: () => ({ state }), useToast: () => ({ add }), useSeoMeta: () => {} })) vi.stubGlobal(name, value)
  const wrapper = mount(Settings, { global: { components: { ProjectThumbnail, UButton: Button, UDashboardPanel: Container, UCard: Container }, stubs: { UInput: true, UInputNumber: true, UFormField: true, USelectMenu: true, USwitch: true, UModal: true, UIcon: true } } })
  async function choose(file: File) {
    const input = wrapper.get('input[type=file]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()
  }
  return { wrapper, state, choose }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it('rejects invalid files before uploading', async () => {
  const { choose, state } = setup()
  await choose(new File(['pdf'], 'file.pdf', { type: 'application/pdf' }))
  expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'error', description: expect.stringContaining('PNG') }))
  await choose(new File([new Uint8Array(3 * 1024 * 1024)], 'large.png', { type: 'image/png' }))
  expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'error', description: 'The image is over 2 MB.' }))
  expect(setThumbnail).not.toHaveBeenCalled()
  expect(state.value.projects[0]!.thumbnailUrl).toBeNull()
})
it('shows pending state, updates shared thumbnails, and keeps colour edits through image writes', async () => {
  let finish!: (p: Project) => void
  setThumbnail.mockReturnValue(new Promise<Project>((resolve) => {
    finish = resolve
  }))
  clearThumbnail.mockResolvedValue(original)
  const { wrapper, state, choose } = setup()
  expect(wrapper.text()).not.toContain('Remove image')
  const file = new File(['png'], 'image.png', { type: 'image/png' })
  await choose(file)
  expect(setThumbnail).toHaveBeenCalledWith('test-app', file)
  expect(wrapper.find('[role=status]').exists()).toBe(true)
  await wrapper.get('[role=radio]').trigger('click')
  finish({ ...original, thumbnailUrl: '/new.png' })
  await flushPromises()
  expect(wrapper.find('[role=status]').exists()).toBe(false)
  expect(state.value.projects[0]!.thumbnailUrl).toBe('/new.png')
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
  const { choose, state, wrapper } = setup()
  state.value.projects = [{ ...original, thumbnailUrl: '/previous.png' }]
  await choose(new File(['bad'], 'bad.png', { type: 'image/png' }))
  expect(wrapper.get('img').attributes('src')).toBe('/previous.png')
  expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ description: 'The file is not a PNG image', color: 'error' }))
  await wrapper.findAll('button').find(b => b.text() === 'Remove image')!.trigger('click')
  await flushPromises()
  expect(wrapper.get('img').attributes('src')).toBe('/previous.png')
  expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ description: 'Could not remove image', color: 'error' }))
})
