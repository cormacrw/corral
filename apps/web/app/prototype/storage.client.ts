// The static prototype (`pnpm prototype`, D20) runs in a sandboxed iframe
// with an opaque origin, where reading document.cookie or localStorage
// throws. Nuxt UI keeps panel sizes in a cookie, so stand in memory for both:
// preferences last until reload. Registered only in the prototype build
// (nuxt.config.ts).
export default defineNuxtPlugin({
  enforce: 'pre',
  setup() {
    try {
      void document.cookie
    } catch {
      let cookies: Record<string, string> = {}
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        set: (value: string) => {
          const [pair = ''] = value.split(';')
          const index = pair.indexOf('=')
          const name = pair.slice(0, index).trim()
          if (!name) return
          // An expired cookie is a delete
          if (/max-age=-|expires=thu, 01 jan 1970/i.test(value)) {
            cookies = Object.fromEntries(Object.entries(cookies).filter(([k]) => k !== name))
          } else cookies[name] = pair.slice(index + 1).trim()
        }
      })
    }

    try {
      void window.localStorage
    } catch {
      const items = new Map<string, string>()
      const storage: Storage = {
        get length() {
          return items.size
        },
        key: index => [...items.keys()][index] ?? null,
        getItem: key => items.get(key) ?? null,
        setItem: (key, value) => void items.set(key, String(value)),
        removeItem: key => void items.delete(key),
        clear: () => items.clear()
      }
      Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
      Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storage })
    }
  }
})
