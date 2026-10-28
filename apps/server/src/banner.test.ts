import { describe, expect, it } from 'vitest'
import { formatDuration, redactUrl } from './banner.ts'

describe('redactUrl', () => {
  it('hides the password', () => {
    expect(redactUrl('postgres://corral:s3cret@postgres:5432/corral')).toBe('postgres://corral:***@postgres:5432/corral')
  })

  it('leaves a URL without a password alone', () => {
    expect(redactUrl('postgres://corral@postgres:5432/corral')).toBe('postgres://corral@postgres:5432/corral')
  })
})

describe('formatDuration', () => {
  it('uses ms under a second and seconds above', () => {
    expect(formatDuration(312.4)).toBe('312ms')
    expect(formatDuration(1480)).toBe('1.48s')
  })
})
