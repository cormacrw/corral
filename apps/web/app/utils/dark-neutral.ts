export const DARK_NEUTRALS = ['slate', 'gray', 'zinc', 'neutral', 'stone', 'mauve', 'olive', 'mist', 'taupe'] as const
export type DarkNeutral = typeof DARK_NEUTRALS[number]
export const DARK_NEUTRAL_KEY = 'corral.device.darkNeutral'

export function parseDarkNeutral(value: unknown): DarkNeutral {
  return DARK_NEUTRALS.includes(value as DarkNeutral) ? value as DarkNeutral : 'slate'
}

export function readDarkNeutral(): DarkNeutral {
  try {
    return parseDarkNeutral(localStorage.getItem(DARK_NEUTRAL_KEY))
  } catch {
    return 'slate'
  }
}

// Runs in the static head before the app or its styles paint. Keep the same
// validation as the composable; storage may be blocked in sandboxed previews.
export const darkNeutralInit = `try { document.documentElement.dataset.darkNeutral = ${JSON.stringify(DARK_NEUTRALS)}.includes(localStorage.getItem('${DARK_NEUTRAL_KEY}')) ? localStorage.getItem('${DARK_NEUTRAL_KEY}') : 'slate' } catch {}`
