import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { checkCpus } from './check-cpus.ts'

const cpus = checkCpus()
const review = process.argv.slice(2)
if (review.some(arg => arg !== '--review') || review.length > 1) {
  throw new Error('Usage: pnpm run check [--review]; set CORRAL_CHECK_CPUS to change the worker cap')
}
const isReview = review.length === 1
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CORRAL_CHECK_CPUS: String(cpus),
  // Vitest's environment override takes precedence over its config file.
  VITEST_MAX_WORKERS: String(cpus)
}
if (isReview) env.TURBO_FORCE = '1'

async function run(command: string, args: string[], capture = false): Promise<string> {
  return new Promise((res, reject) => {
    const child = spawn(command, args, { env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
    let output = ''
    child.stdout?.on('data', (data) => {
      output += data
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code !== 0) reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`))
      else res(output.trim())
    })
  })
}

// Reviewer worktrees are retained between runs. Never reuse a developer's
// cached run or a check made against uncommitted changes.
const head = await run('git', ['rev-parse', 'HEAD'], true)
const clean = async () => (await run('git', ['status', '--porcelain', '--untracked-files=normal'], true)) === ''
const receiptPath = resolve('.corral', 'checks', `${head}.json`)
if (isReview && await clean()) {
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { version: number, head: string, run: string, at: string }
    if (receipt.version === 1 && receipt.head === head && receipt.run && receipt.at) {
      console.log(`Reused clean review check run ${receipt.run} (${receipt.at}) for commit ${head}. Cite this earlier run in your review summary.`)
      process.exit(0)
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
const startedClean = await clean()
await run('pnpm', ['exec', 'turbo', 'run', 'lint', 'typecheck', 'test', `--concurrency=${cpus}`])
// Root scripts aren't workspace Turbo tasks.
await run('pnpm', ['exec', 'eslint', 'scripts'])
await run('pnpm', ['exec', 'tsc'])
if (isReview && startedClean && await clean() && head === await run('git', ['rev-parse', 'HEAD'], true)) {
  const receipt = { version: 1, head, run: randomUUID(), at: new Date().toISOString() }
  await mkdir(resolve(receiptPath, '..'), { recursive: true })
  await writeFile(receiptPath, JSON.stringify(receipt))
  console.log(`Saved clean review check run ${receipt.run} (${receipt.at}) for commit ${head}.`)
}
