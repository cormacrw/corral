import { describe, expect, it } from 'vitest'
import { parseOverride, resolveDevice } from './device.ts'

const desktop = { narrowTouch: false, standalone: false }

describe('resolveDevice', () => {
  it('uses the web layout on a desktop viewport', () => {
    expect(resolveDevice('auto', desktop)).toBe('web')
  })

  it('uses the mobile layout on a small touch screen', () => {
    expect(resolveDevice('auto', { narrowTouch: true, standalone: false })).toBe('mobile')
  })

  it('uses the mobile layout in the installed app', () => {
    expect(resolveDevice('auto', { narrowTouch: false, standalone: true })).toBe('mobile')
  })

  it('lets the override force either layout', () => {
    expect(resolveDevice('mobile', desktop)).toBe('mobile')
    expect(resolveDevice('desktop', { narrowTouch: true, standalone: true })).toBe('web')
  })
})

describe('parseOverride', () => {
  it('falls back to auto for anything unknown', () => {
    expect(parseOverride('mobile')).toBe('mobile')
    expect(parseOverride('tablet')).toBe('auto')
    expect(parseOverride(null)).toBe('auto')
  })
})
