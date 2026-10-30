import { recordAppHistoryPosition } from '~/utils/app-history'

// Records where Corral's own history begins in this browser tab, for the
// mobile tab bar's reset (utils/app-history.ts).
export default defineNuxtPlugin(() => {
  recordAppHistoryPosition(window.history.state?.position)
  window.addEventListener('popstate', () => recordAppHistoryPosition(window.history.state?.position))
})
