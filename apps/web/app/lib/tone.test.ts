import { describe, expect, it } from 'vitest'
import { buttonToneClass, TONE_CLASSES } from './tone'

describe('buttonToneClass', () => {
  it('fills solid buttons and washes the rest on hover', () => {
    expect(buttonToneClass('primary', 'solid')).toContain('hover:bg-primary/80')
    expect(buttonToneClass('error', 'soft')).toContain('hover:bg-destructive/15')
  })

  it('leaves ghost and link buttons without a fill until hover', () => {
    expect(buttonToneClass('neutral', 'ghost')).toBe('text-foreground hover:bg-muted')
    expect(buttonToneClass('success', 'link')).not.toContain(' bg-')
  })

  it('has every appearance for every tone', () => {
    for (const tone of Object.values(TONE_CLASSES)) expect(Object.keys(tone)).toEqual(['solid', 'outline', 'soft', 'subtle'])
  })
})
