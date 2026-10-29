import type { DeviceMode, DeviceOverride } from '~/utils/device'
import { NARROW_TOUCH_QUERY, parseOverride, resolveDevice, STANDALONE_QUERY } from '~/utils/device'

// Which layout this device gets (D17, design/mobile.md). The root picks
// layouts/mobile.vue from it, and pages use it to choose mobile components.
// Re-evaluated when the viewport or display mode changes.
const OVERRIDE_KEY = 'corral.device.layout'

let listening = false

function readOverride(): DeviceOverride {
  try {
    return parseOverride(localStorage.getItem(OVERRIDE_KEY))
  } catch {
    // Storage can be unavailable in private windows
    return 'auto'
  }
}

export function useDevice() {
  const override = useState<DeviceOverride>('device.override', () => import.meta.client ? readOverride() : 'auto')
  const media = useState('device.media', () => ({ narrowTouch: false, standalone: false }))

  if (import.meta.client && !listening) {
    listening = true
    const narrowTouch = window.matchMedia(NARROW_TOUCH_QUERY)
    const standalone = window.matchMedia(STANDALONE_QUERY)
    const update = () => {
      media.value = { narrowTouch: narrowTouch.matches, standalone: standalone.matches }
    }
    update()
    narrowTouch.addEventListener('change', update)
    standalone.addEventListener('change', update)
  }

  const mode = computed<DeviceMode>(() => resolveDevice(override.value, media.value))

  function setOverride(next: DeviceOverride): void {
    override.value = next
    try {
      if (next === 'auto') localStorage.removeItem(OVERRIDE_KEY)
      else localStorage.setItem(OVERRIDE_KEY, next)
    } catch {
      // The choice applies now but won't survive a reload
    }
  }

  return { mode, isMobile: computed(() => mode.value === 'mobile'), override: readonly(override), setOverride }
}
