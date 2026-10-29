import { describe, expect, it } from 'vitest'
import { installMode, isIos } from './install.ts'

describe('installMode', () => {
  it('offers the browser prompt when Chrome has one', () => {
    expect(installMode({ standalone: false, promptAvailable: true, ios: false })).toBe('prompt')
  })

  it('shows the Add to Home Screen steps on iOS', () => {
    expect(installMode({ standalone: false, promptAvailable: false, ios: true })).toBe('ios')
  })

  it('offers nothing once installed, or where the browser can\'t install', () => {
    expect(installMode({ standalone: true, promptAvailable: true, ios: false })).toBeNull()
    expect(installMode({ standalone: true, promptAvailable: false, ios: true })).toBeNull()
    expect(installMode({ standalone: false, promptAvailable: false, ios: false })).toBeNull()
  })
})

describe('isIos', () => {
  it('spots iPhones and iPads, including iPadOS posing as a Mac', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', 5)).toBe(true)
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5)).toBe(true)
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0)).toBe(false)
    expect(isIos('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', 5)).toBe(false)
  })
})
