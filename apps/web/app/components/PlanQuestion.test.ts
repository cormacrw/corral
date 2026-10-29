// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { STOP_ASKING } from '~/utils/plan-questions'
import PlanGrillButton from './PlanGrillButton.vue'
import PlanQuestion from './PlanQuestion.vue'

// Events are checked through on* handlers, since wrapper.emitted() misses
// them under a production NODE_ENV
// Nuxt UI needs the Nuxt app, so its button is a plain one here
const UButton = defineComponent({
  props: { label: String, disabled: Boolean, variant: String, icon: String },
  emits: ['click'],
  setup: (props, { emit, attrs }) => () => h('button', { ...attrs, 'disabled': props.disabled, 'data-variant': props.variant, 'onClick': () => emit('click') }, props.label)
})
const MarkdownText = defineComponent({ props: { text: String }, setup: props => () => h('p', props.text) })
const global = { components: { UButton, MarkdownText } }

const question = { text: 'Which database?', recommendation: 'Postgres', options: ['Postgres', 'SQLite', 'MySQL'] }
const buttons = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('button')
const labels = (wrapper: ReturnType<typeof mount>) => buttons(wrapper).map(b => b.text())
const button = (wrapper: ReturnType<typeof mount>, label: string) => buttons(wrapper).find(b => b.text() === label)!

describe('PlanQuestion', () => {
  it('offers the recommendation, each option, Other… and Stop', () => {
    const wrapper = mount(PlanQuestion, { props: { message: question, active: true }, global })
    expect(wrapper.text()).toContain('Recommended: Postgres')
    expect(labels(wrapper)).toEqual(['Accept recommendation', 'Postgres', 'SQLite', 'MySQL', 'Other…', 'Stop and propose the plan'])
    expect(buttons(wrapper).every(b => !b.attributes('disabled'))).toBe(true)
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

  it('works with only a recommendation, or only options', () => {
    const recommended = mount(PlanQuestion, { props: { message: { ...question, options: null }, active: true }, global })
    expect(labels(recommended)).toEqual(['Accept recommendation', 'Other…', 'Stop and propose the plan'])
    const options = mount(PlanQuestion, { props: { message: { ...question, recommendation: null }, active: true }, global })
    expect(labels(options)).toEqual(['Postgres', 'SQLite', 'MySQL', 'Other…', 'Stop and propose the plan'])
  })

  it('has no buttons without a recommendation or options', () => {
    const wrapper = mount(PlanQuestion, { props: { message: { text: 'Why?', recommendation: null, options: null }, active: true }, global })
    expect(buttons(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toBe('QuestionWhy?')
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
    expect(button(wrapper, chosen).attributes('data-variant')).toBe('solid')
    expect(buttons(wrapper).every(b => b.attributes('disabled') !== undefined)).toBe(true)
  })
})

describe('PlanGrillButton', () => {
  it('sends Grill me with an empty composer', async () => {
    const onSend = vi.fn()
    const wrapper = mount(PlanGrillButton, { props: { draft: '  ', onSend }, global })
    await wrapper.find('button').trigger('click')
    expect(onSend.mock.calls).toEqual([['Grill me']])
  })

  it('sends the draft with it', async () => {
    const onSend = vi.fn()
    const wrapper = mount(PlanGrillButton, { props: { draft: 'A billing page', onSend }, global })
    await wrapper.find('button').trigger('click')
    expect(onSend.mock.calls).toEqual([['Grill me on this: A billing page']])
  })

  it('is disabled while a turn is running', () => {
    const wrapper = mount(PlanGrillButton, { props: { draft: '', disabled: true }, global })
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
  })
})
