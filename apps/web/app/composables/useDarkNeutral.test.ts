// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readonly, ref } from 'vue'
import { DARK_NEUTRALS, DARK_NEUTRAL_KEY, darkNeutralInit } from '../utils/dark-neutral'
import { useDarkNeutral } from './useDarkNeutral'

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

  it('defaults to slate and shares updates between settings screens', () => {
    const first = useDarkNeutral()
    const second = useDarkNeutral()
    expect(first.palette.value).toBe('slate')
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
    expect(useDarkNeutral().palette.value).toBe('slate')
    new Function(darkNeutralInit)()
    expect(document.documentElement.dataset.darkNeutral).toBe('slate')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => useDarkNeutral().setPalette('stone')).not.toThrow()
    vi.restoreAllMocks()
  })

  it('maps every shade of every palette only under .dark and retains its variables', () => {
    const css = readFileSync('app/assets/css/main.css', 'utf8')
    for (const palette of DARK_NEUTRALS) {
      useDarkNeutral().setPalette(palette)
      const source = palette === 'neutral' ? 'old-neutral' : palette
      const rule = css.split(`.dark[data-dark-neutral="${palette}"] {`)[1]?.split('}')[0]
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(rule).toContain(`--ui-color-neutral-${shade}: var(--color-${source}-${shade})`)
        expect(css).toContain(`--dark-neutral-${palette}-${shade}: var(--color-${source}-${shade})`)
      }
    }
  })
})
