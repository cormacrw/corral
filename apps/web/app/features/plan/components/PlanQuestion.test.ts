// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { STOP_ASKING } from '~/features/plan/utils/plan-questions'
import PlanGrillButton from '~/features/plan/components/PlanGrillButton.vue'
import PlanQuestion from '~/features/plan/components/PlanQuestion.vue'
import InboxQuestionAnswer from '~/features/inbox/components/InboxQuestionAnswer.vue'

enableAutoUnmount(afterEach)

// Events are checked through on* handlers, since wrapper.emitted() misses
// them under a production NODE_ENV
// Nuxt UI needs the Nuxt app, so its button is a plain one here
const AppButton = defineComponent({
  props: { label: String, disabled: Boolean, icon: String },
  emits: ['click'],
  setup: (props, { emit, attrs }) => () => h('button', { ...attrs, disabled: props.disabled, onClick: () => emit('click') }, props.label)
})
const MarkdownText = defineComponent({ props: { text: String }, setup: props => () => h('p', props.text) })
const AppTextarea = defineComponent({
  props: { modelValue: String, disabled: Boolean },
  emits: ['update:modelValue'],
  setup: (props, { emit, attrs }) => () => h('textarea', { ...attrs, value: props.modelValue, disabled: props.disabled, onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLTextAreaElement).value) })
})
const global = { components: { AppButton, AppTextarea, MarkdownText } }

const question = { text: 'Which database?', recommendation: 'Postgres', options: ['Postgres', 'SQLite', 'MySQL'] }
const buttons = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('button')
const labels = (wrapper: ReturnType<typeof mount>) => buttons(wrapper).map(b => b.text())
const button = (wrapper: ReturnType<typeof mount>, label: string) => buttons(wrapper).find(b => b.text() === label)!

describe('PlanQuestion', () => {
  it('writes Other… in the card when asked to, and submits it with Cmd or Ctrl+Enter', async () => {
    const onSubmit = vi.fn()
    const onUpdate = vi.fn()
    const closed = mount(PlanQuestion, { props: { message: question, active: true }, global })
    expect(closed.find('[data-testid="plan-question-other"]').exists()).toBe(false)
    // The Inbox writes it in the card's other slot
    const other = () => h(InboxQuestionAnswer, { 'modelValue': '', 'onSubmit': onSubmit, 'onUpdate:modelValue': onUpdate })
    const wrapper = mount(PlanQuestion, { props: { message: question, active: true, writing: true }, slots: { other }, global })
    const input = wrapper.get('[data-testid="plan-question-other"]')
    expect(button(wrapper, 'Other…').attributes('aria-pressed')).toBe('true')
    await input.setValue('CockroachDB')
    expect(onUpdate).toHaveBeenCalledWith('CockroachDB')
    await input.trigger('keydown', { key: 'Enter', metaKey: true })
    await input.trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(2)
    // A past question never opens it
    const past = mount(PlanQuestion, { props: { message: question, active: false, writing: true }, slots: { other }, global })
    expect(past.find('[data-testid="plan-question-other"]').exists()).toBe(false)
  })

  it('sends the tapped answer', async () => {
    const onAnswer = vi.fn()
    const onOther = vi.fn()
    const onStop = vi.fn()
    const wrapper = mount(PlanQuestion, { props: { message: question, active: true, onAnswer, onOther, onStop }, global })
    await button(wrapper, 'Accept recommendation').trigger('click')
    await button(wrapper, 'SQLite').trigger('click')
    await button(wrapper, 'Other…').trigger('click')
    await button(wrapper, 'Stop and propose the plan').trigger('click')
    expect(onAnswer.mock.calls).toEqual([['Postgres'], ['SQLite']])
    expect(onOther).toHaveBeenCalledOnce()
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('enables its buttons on the open question', () => {
    const wrapper = mount(PlanQuestion, { props: { message: question, active: true }, global })
    expect(buttons(wrapper).every(b => !b.attributes('disabled'))).toBe(true)
  })

  it('works with only a recommendation, or only options', () => {
    const recommended = mount(PlanQuestion, { props: { message: { ...question, options: null }, active: true }, global })
    expect(labels(recommended)).toContain('Accept recommendation')
    expect(labels(recommended)).not.toContain('SQLite')
    const options = mount(PlanQuestion, { props: { message: { ...question, recommendation: null }, active: true }, global })
    expect(labels(options)).not.toContain('Accept recommendation')
    expect(labels(options)).toEqual(expect.arrayContaining(['Postgres', 'SQLite', 'MySQL']))
  })

  it('has no buttons without a recommendation or options', () => {
    const wrapper = mount(PlanQuestion, { props: { message: { text: 'Why?', recommendation: null, options: null }, active: true }, global })
    expect(buttons(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('Why?')
  })

  it('disables every button on an older question', () => {
    const wrapper = mount(PlanQuestion, { props: { message: question, active: false }, global })
    expect(buttons(wrapper).every(b => b.attributes('disabled') !== undefined)).toBe(true)
  })

  it('disables every button while a turn is running', () => {
    const wrapper = mount(PlanQuestion, { props: { message: question, active: true, disabled: true }, global })
    expect(buttons(wrapper).every(b => b.attributes('disabled') !== undefined)).toBe(true)
  })

  it.each([
    ['an option', 'SQLite', 'SQLite'],
    ['the recommendation', 'Postgres', 'Accept recommendation'],
    ['Stop', STOP_ASKING, 'Stop and propose the plan'],
    ['a free-text reply', 'Something else entirely', 'Other…']
  ])('marks %s as the chosen answer once answered', (_, answer, chosen) => {
    const wrapper = mount(PlanQuestion, { props: { message: question, active: false, answer }, global })
    const pressed = buttons(wrapper).filter(b => b.attributes('aria-pressed') === 'true').map(b => b.text())
    expect(pressed).toContain(chosen)
    expect(buttons(wrapper).every(b => b.attributes('disabled') !== undefined)).toBe(true)
  })
})

describe('PlanGrillButton', () => {
  it('sends the draft with it', async () => {
    const onSend = vi.fn()
    const wrapper = mount(PlanGrillButton, { props: { draft: 'A billing page', onSend }, global })
    await wrapper.find('button').trigger('click')
    expect(onSend).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('A billing page'))
  })

  it('is disabled while a turn is running', () => {
    const wrapper = mount(PlanGrillButton, { props: { draft: '', disabled: true }, global })
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
  })
})
