// Mobile or web layout (D17, design/mobile.md). Auto follows the device;
// the override is saved per device so a phone or laptop can force either.
export type DeviceMode = 'mobile' | 'web'
export type DeviceOverride = 'auto' | 'desktop' | 'mobile'

export const DEVICE_OVERRIDES: DeviceOverride[] = ['auto', 'desktop', 'mobile']

// A small touch screen, or the installed PWA
export const NARROW_TOUCH_QUERY = '(max-width: 767px) and (pointer: coarse)'
export const STANDALONE_QUERY = '(display-mode: standalone)'

export interface DeviceMedia {
  narrowTouch: boolean
  standalone: boolean
}

export function resolveDevice(override: DeviceOverride, media: DeviceMedia): DeviceMode {
  if (override === 'desktop') return 'web'
  if (override === 'mobile') return 'mobile'
  return media.narrowTouch || media.standalone ? 'mobile' : 'web'
}

export function parseOverride(value: unknown): DeviceOverride {
  return DEVICE_OVERRIDES.includes(value as DeviceOverride) ? value as DeviceOverride : 'auto'
}
