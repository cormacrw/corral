import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecResult } from './exec.ts'

// Records every git call, holding fetches open for a moment so overlapping
// ones would show up
const calls: { args: string[], cwd: string | undefined, start: number, end: number }[] = []
vi.mock('./exec.ts', () => ({
  git: async (args: string[], options: { cwd?: string } = {}): Promise<ExecResult> => {
    const call = { args, cwd: options.cwd, start: performance.now(), end: 0 }
    calls.push(call)
    if (args[0] === 'fetch') await new Promise(resolve => setTimeout(resolve, 30))
    call.end = performance.now()
    return { code: args.includes('fail') ? 1 : 0, stdout: '', stderr: '' }
  }
}))

const { barePath } = await import('./layout.ts')
const { openRepo } = await import('./repos.ts')

function overlaps(list: typeof calls): boolean {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  return sorted.some((call, i) => i > 0 && call.start < sorted[i - 1]!.end)
}

describe('Repo.sync', () => {
  let dataDir: string

  beforeEach(async () => {
    calls.length = 0
    dataDir = await mkdtemp(join(tmpdir(), 'corral-repos-'))
    await mkdir(barePath(dataDir, 'acme/app'), { recursive: true })
    await mkdir(barePath(dataDir, 'acme/other'), { recursive: true })
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('shares one fetch between callers that arrive before it starts', async () => {
    const results = await Promise.all([1, 2, 3].map(() => openRepo(dataDir, 'acme/app').sync()))
    expect(results).toEqual([null, null, null])
    expect(calls.filter(c => c.args[0] === 'fetch')).toHaveLength(1)
  })

  it('never joins a fetch already running: callers during it share the next one', async () => {
    const first = openRepo(dataDir, 'acme/app').sync()
    await vi.waitFor(() => expect(calls.some(c => c.args[0] === 'fetch')).toBe(true), { timeout: 5000, interval: 1 })
    expect(calls.filter(c => c.args[0] === 'fetch')[0]!.end).toBe(0)

    const later = [openRepo(dataDir, 'acme/app').sync(), openRepo(dataDir, 'acme/app').sync()]
    await Promise.all([first, ...later])

    const fetches = calls.filter(c => c.args[0] === 'fetch')
    expect(fetches).toHaveLength(2)
    expect(overlaps(fetches)).toBe(false)
  })

  it('starts a new fetch once the last has finished', async () => {
    await openRepo(dataDir, 'acme/app').sync()
    await openRepo(dataDir, 'acme/app').sync()
    expect(calls.filter(c => c.args[0] === 'fetch')).toHaveLength(2)
  })

  it('fetches different repos in parallel', async () => {
    await Promise.all([openRepo(dataDir, 'acme/app').sync(), openRepo(dataDir, 'acme/other').sync()])
    const fetches = calls.filter(c => c.args[0] === 'fetch')
    expect(new Set(fetches.map(f => f.cwd)).size).toBe(2)
    expect(overlaps(fetches)).toBe(true)
  })
})

describe('Repo.withLock', () => {
  it('runs the next job after one that failed, across handles to the same clone', async () => {
    const order: string[] = []
    const first = openRepo('/data', 'acme/app').withLock(async () => {
      order.push('first')
      throw new Error('boom')
    })
    const second = openRepo('/data', 'acme/app').withLock(async () => {
      order.push('second')
      return 2
    })
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe(2)
    expect(order).toEqual(['first', 'second'])
  })
})
