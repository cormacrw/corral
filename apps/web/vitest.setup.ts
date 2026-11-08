import { config } from '@vue/test-utils'

// Without Nuxt there are no auto-imported components, so a child a test does
// not register renders as a plain element, as a shallow stub would. Vue warns
// about each one and prints the component's props, refs and all, to stderr.
// Other warnings still print, with the trace as text.
config.global.config.warnHandler = (message, _instance, trace) => {
  if (message.startsWith('Failed to resolve component')) return
  console.warn(`[Vue warn]: ${message}${trace ? `\n${trace}` : ''}`)
}
