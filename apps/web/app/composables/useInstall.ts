import { installMode, isIos } from '~/utils/install'
import { STANDALONE_QUERY } from '~/utils/device'

// Chrome's install prompt event; not in TypeScript's DOM types
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// Whether Corral can be installed here, and how (utils/install.ts).
// plugins/pwa.client.ts keeps the prompt, which Chrome fires once, early.
export function useInstall() {
  const prompt = useState<BeforeInstallPromptEvent | null>('install.prompt', () => null)
  const standalone = useState('install.standalone', () => false)
  const open = useState('install.open', () => false)
  const ios = import.meta.client && isIos(navigator.userAgent, navigator.maxTouchPoints)

  const mode = computed(() => installMode({ standalone: standalone.value, promptAvailable: prompt.value !== null, ios }))

  async function install(): Promise<void> {
    const event = prompt.value
    if (!event) return
    // Chrome allows each prompt to be shown once
    prompt.value = null
    await event.prompt()
    const { outcome } = await event.userChoice
    if (outcome === 'accepted') open.value = false
  }

  return { mode, open, install, prompt, standalone }
}

// Safari's own flag covers iOS versions without the display-mode query
export function runningStandalone(): boolean {
  return window.matchMedia(STANDALONE_QUERY).matches || (navigator as { standalone?: boolean }).standalone === true
}
