// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readonly, ref } from 'vue'
import { DARK_NEUTRAL_KEY, darkNeutralInit } from '~/utils/dark-neutral'
import { useDarkNeutral } from '~/composables/useDarkNeutral'

describe('device dark neutral', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.darkNeutral
    const states = new Map()
    vi.stubGlobal('readonly', readonly)
    vi.stubGlobal('useState', (key: string, init: () => string) => {
      if (!states.has(key)) states.set(key, ref(init()))
      return states.get(key)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defaults to neutral and shares updates between settings screens', () => {
    const first = useDarkNeutral()
    const second = useDarkNeutral()
    expect(first.palette.value).toBe('neutral')
    first.setPalette('mauve')
    expect(second.palette.value).toBe('mauve')
    expect(document.documentElement.dataset.darkNeutral).toBe('mauve')
    expect(localStorage.getItem(DARK_NEUTRAL_KEY)).toBe('mauve')
  })

  it('restores storage before app startup and initializes the composable', () => {
    localStorage.setItem(DARK_NEUTRAL_KEY, 'olive')
    new Function(darkNeutralInit)()
    expect(document.documentElement.dataset.darkNeutral).toBe('olive')
    expect(useDarkNeutral().palette.value).toBe('olive')
  })

  it('rejects invalid storage and handles blocked storage', () => {
    localStorage.setItem(DARK_NEUTRAL_KEY, 'red')
    expect(useDarkNeutral().palette.value).toBe('neutral')
    new Function(darkNeutralInit)()
    expect(document.documentElement.dataset.darkNeutral).toBe('neutral')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => useDarkNeutral().setPalette('stone')).not.toThrow()
  })
})
