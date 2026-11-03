// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readonly, ref } from 'vue'
import { DARK_NEUTRALS, DARK_NEUTRAL_KEY, darkNeutralInit } from '~/features/settings/utils/dark-neutral'
import { useDarkNeutral } from '~/features/settings/composables/useDarkNeutral'

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
  afterEach(() => vi.unstubAllGlobals())

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
    vi.restoreAllMocks()
  })

  it('maps every shade of every palette only under .dark and retains its variables', () => {
    const css = readFileSync('app/assets/css/dark-neutrals.css', 'utf8')
    for (const palette of DARK_NEUTRALS) {
      useDarkNeutral().setPalette(palette)
      const rule = css.split(`.dark[data-dark-neutral="${palette}"] {`)[1]?.split('}')[0]
      for (const shade of [50, 100, 200, 300, 400, 500, 700, 800, 900, 950]) {
        expect(rule).toContain(`--surface-${shade}: var(--color-${palette}-${shade})`)
      }
    }
  })
})
