import type { BeforeInstallPromptEvent } from '~/composables/useInstall'
import { runningStandalone } from '~/composables/useInstall'
import { STANDALONE_QUERY } from '~/utils/device'

// The installable app (D17, design/mobile.md): registers public/sw.js, which
// caches the built shell only, and keeps Chrome's install prompt for the
// Install screen. Dev builds skip the worker so it can't cache Vite's modules, and the
// static prototype has no worker to register.
export default defineNuxtPlugin(() => {
  const { prompt, standalone } = useInstall()

  standalone.value = runningStandalone()
  window.matchMedia(STANDALONE_QUERY).addEventListener('change', () => {
    standalone.value = runningStandalone()
  })

  window.addEventListener('beforeinstallprompt', (event) => {
    // Show it from the Install screen instead of Chrome's own mini-bar
    event.preventDefault()
    prompt.value = event as BeforeInstallPromptEvent
  })
  window.addEventListener('appinstalled', () => {
    prompt.value = null
  })

  if (!import.meta.dev && !import.meta.prototype && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      console.warn('Service worker not registered', error)
    })
  }
})
