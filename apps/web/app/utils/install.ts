// Installing Corral as an app (D17, design/mobile.md). Chrome and Android
// offer a prompt through `beforeinstallprompt`; iOS has none, so it gets the
// Add to Home Screen steps instead. Nothing is offered once installed.
export type InstallMode = 'prompt' | 'ios'

export interface InstallEnvironment {
  standalone: boolean
  promptAvailable: boolean
  ios: boolean
}

export function installMode(env: InstallEnvironment): InstallMode | null {
  if (env.standalone) return null
  if (env.promptAvailable) return 'prompt'
  if (env.ios) return 'ios'
  return null
}

// iPadOS reports itself as a Mac, but a Mac has no touch screen
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
}
