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

const { barePath, syncRepository, withRepoLock } = await import('./repos.ts')

function overlaps(list: typeof calls): boolean {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  return sorted.some((call, i) => i > 0 && call.start < sorted[i - 1]!.end)
}

describe('syncRepository', () => {
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

  it('fetches into one bare repo one at a time', async () => {
    const results = await Promise.all([1, 2, 3].map(() => syncRepository(dataDir, 'acme/app')))
    expect(results).toEqual([null, null, null])
    const fetches = calls.filter(c => c.args[0] === 'fetch')
    expect(fetches).toHaveLength(3)
    expect(overlaps(fetches)).toBe(false)
  })

  it('fetches different repos in parallel', async () => {
    await Promise.all([syncRepository(dataDir, 'acme/app'), syncRepository(dataDir, 'acme/other')])
    const fetches = calls.filter(c => c.args[0] === 'fetch')
    expect(new Set(fetches.map(f => f.cwd)).size).toBe(2)
    expect(overlaps(fetches)).toBe(true)
  })
})

describe('withRepoLock', () => {
  it('runs the next job after one that failed', async () => {
    const order: string[] = []
    const first = withRepoLock('/repo', async () => {
      order.push('first')
      throw new Error('boom')
    })
    const second = withRepoLock('/repo', async () => {
      order.push('second')
      return 2
    })
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe(2)
    expect(order).toEqual(['first', 'second'])
  })
})
