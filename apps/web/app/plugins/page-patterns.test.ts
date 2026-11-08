import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PAGE_PATTERNS } from '@corral/contracts/client'
import { expect, it } from 'vitest'

// The perf plugin records a page only under a known pattern. A page is each
// route's last match: a file whose folder holds child pages wraps them instead.
it('names every page the app routes to', () => {
  const root = fileURLToPath(new URL('../pages', import.meta.url))
  const files = (readdirSync(root, { recursive: true }) as string[]).filter(file => file.endsWith('.vue')).map(file => file.replaceAll('\\', '/').slice(0, -'.vue'.length))
  const pages = files.filter(file => !files.some(other => other.startsWith(`${file}/`)))
  const patterns = pages.map(file => `/${file}`.replace(/\/index$/, '') || '/')
  expect([...PAGE_PATTERNS].sort()).toEqual([...new Set(patterns)].sort())
})
