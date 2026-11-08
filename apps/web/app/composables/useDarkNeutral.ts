import type { DarkNeutral } from '~/utils/dark-neutral'
import { DARK_NEUTRAL_KEY, parseDarkNeutral, readDarkNeutral } from '~/utils/dark-neutral'

export function useDarkNeutral() {
  const palette = useState<DarkNeutral>('dark-neutral', readDarkNeutral)

  function setPalette(value: DarkNeutral) {
    palette.value = parseDarkNeutral(value)
    document.documentElement.dataset.darkNeutral = palette.value
    try {
      localStorage.setItem(DARK_NEUTRAL_KEY, palette.value)
    } catch {
      // Still applies for this session when storage is unavailable.
    }
  }

  return { palette: readonly(palette), setPalette }
}
