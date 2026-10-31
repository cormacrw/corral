import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exec } from './exec.ts'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('exec', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'corral-exec-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports a timeout and stops the whole group', async () => {
    const script = join(dir, 'hang')
    await writeFile(script, `#!/bin/sh\nsleep 30 &\necho $! > '${join(dir, 'pid')}'\nwait\n`)
    await chmod(script, 0o755)

    const result = await exec(script, [], { timeoutMs: 200, group: true })

    expect(result).toMatchObject({ code: null, stderr: expect.stringContaining('Timed out after 200 ms') })
    const helper = Number(await readFile(join(dir, 'pid'), 'utf8'))
    await expect.poll(() => alive(helper), { timeout: 3000 }).toBe(false)
  })

  it('lets a group clean up on SIGTERM before it answers', async () => {
    const script = join(dir, 'tidy')
    const lock = join(dir, 'index.lock')
    await writeFile(script, `#!/bin/sh\ntouch '${lock}'\ntrap "rm -f '${lock}'; exit 1" TERM\nsleep 30 &\nwait\n`)
    await chmod(script, 0o755)

    const result = await exec(script, [], { timeoutMs: 200, group: true })

    expect(result.code).toBeNull()
    expect(await stat(lock).catch(() => null)).toBeNull()
  })

  it('kills a group that ignores SIGTERM after the grace period', async () => {
    const script = join(dir, 'stubborn')
    await writeFile(script, `#!/bin/sh\ntrap '' TERM\necho $$ > '${join(dir, 'pid')}'\nwhile true; do sleep 0.1; done\n`)
    await chmod(script, 0o755)

    const result = await exec(script, [], { timeoutMs: 200, group: true })

    expect(result).toMatchObject({ code: null, stderr: expect.stringContaining('Timed out') })
    const pid = Number(await readFile(join(dir, 'pid'), 'utf8'))
    await expect.poll(() => alive(pid), { timeout: 3000 }).toBe(false)
  }, 15_000)

  it('still answers at once for a command outside a group', async () => {
    const started = Date.now()
    const result = await exec('sleep', ['30'], { timeoutMs: 100 })
    expect(result.code).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('stops a command that prints without end, with a reason', async () => {
    const result = await exec('yes', ['x'.repeat(1000)], { timeoutMs: 60_000 })
    expect(result).toMatchObject({ code: null, stderr: expect.stringContaining('characters of output') })
  }, 30_000)

  it('keeps a successful run as it was', async () => {
    expect(await exec('sh', ['-c', 'echo out; echo err >&2'], { group: true })).toEqual({ code: 0, stdout: 'out\n', stderr: 'err\n' })
  })

  it('reports a missing command as code null', async () => {
    expect(await exec(join(dir, 'nothing'), [], { group: true })).toMatchObject({ code: null })
  })
})
