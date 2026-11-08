// Fails on any import cycle between source files of the apps and packages.
// Runs with the scripts package's lint, so `pnpm run check` catches a new one.
//
//   node scripts/check-cycles.ts
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

// The schema's tables reference each other, which Drizzle allows inside
// `references(() => ...)` callbacks (packages/db/src/schema.ts explains the rules)
const ALLOWED = [
  ['packages/db/src/schema/epics.ts', 'packages/db/src/schema/plans.ts', 'packages/db/src/schema/runs.ts', 'packages/db/src/schema/tasks.ts']
]

const IMPORT = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'apps', 'packages'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(file => /\.(ts|vue)$/.test(file) && !/\.test\.ts$|\.perf\.ts$|\/migrations\/|components\/ui\//.test(file) && existsSync(join(root, file)))
const known = new Set(files)

// Relative imports and web's `~/` (Nuxt's app dir). Imports between
// workspace packages can't form a cycle: Turbo refuses a cyclic package graph.
function resolveImport(from: string, specifier: string): string | undefined {
  const web = /^[~@]\//.test(specifier) && from.startsWith('apps/web/')
  if (!specifier.startsWith('.') && !web) return undefined
  const base = web ? join('apps/web/app', specifier.slice(2)) : normalize(join(dirname(from), specifier))
  return [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`, `${base}.vue`].find(candidate => known.has(candidate))
}

const graph = new Map<string, string[]>()
for (const file of files) {
  const source = readFileSync(join(root, file), 'utf8')
  const targets = new Set<string>()
  for (const match of source.matchAll(IMPORT)) {
    const target = resolveImport(file, match[1] ?? match[2]!)
    if (target) targets.add(target)
  }
  graph.set(file, [...targets])
}

// Tarjan's strongly connected components
let next = 0
const index = new Map<string, number>()
const low = new Map<string, number>()
const stack: string[] = []
const onStack = new Set<string>()
const cycles: string[][] = []
function visit(node: string): void {
  index.set(node, next)
  low.set(node, next++)
  stack.push(node)
  onStack.add(node)
  for (const target of graph.get(node) ?? []) {
    if (!index.has(target)) {
      visit(target)
      low.set(node, Math.min(low.get(node)!, low.get(target)!))
    } else if (onStack.has(target)) {
      low.set(node, Math.min(low.get(node)!, index.get(target)!))
    }
  }
  if (low.get(node) !== index.get(node)) return
  const component: string[] = []
  let member: string
  do {
    member = stack.pop()!
    onStack.delete(member)
    component.push(member)
  } while (member !== node)
  if (component.length > 1) cycles.push(component.sort())
}
for (const file of files) if (!index.has(file)) visit(file)

const allowed = new Set(ALLOWED.map(cycle => [...cycle].sort().join('\n')))
const unexpected = cycles.filter(cycle => !allowed.has(cycle.join('\n')))
if (unexpected.length > 0) {
  console.error(`Import cycles (${unexpected.length}). Move what both sides need into a module they can each import:`)
  for (const cycle of unexpected) console.error(`\n  ${cycle.join('\n  ')}`)
  process.exit(1)
}
console.log(`No import cycles in ${files.length} files`)
