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

// Long enough for a script to set itself up (write its pid, set its trap)
// before the timeout fires, even on a busy machine
const SETUP_MS = 1000

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

    const result = await exec(script, [], { timeoutMs: SETUP_MS, group: true })

    expect(result).toMatchObject({ code: null, stderr: expect.stringContaining(`Timed out after ${SETUP_MS} ms`) })
    const helper = Number(await readFile(join(dir, 'pid'), 'utf8'))
    await expect.poll(() => alive(helper), { timeout: 3000 }).toBe(false)
  })

  it('lets a group clean up on SIGTERM before it answers', async () => {
    const script = join(dir, 'tidy')
    const lock = join(dir, 'index.lock')
    await writeFile(script, `#!/bin/sh\ntouch '${lock}'\ntrap "rm -f '${lock}'; exit 1" TERM\nsleep 30 &\nwait\n`)
    await chmod(script, 0o755)

    const result = await exec(script, [], { timeoutMs: SETUP_MS, group: true })

    expect(result.code).toBeNull()
    expect(await stat(lock).catch(() => null)).toBeNull()
  })

  it('kills a group that ignores SIGTERM after the grace period', async () => {
    const script = join(dir, 'stubborn')
    await writeFile(script, `#!/bin/sh\ntrap '' TERM\necho $$ > '${join(dir, 'pid')}'\nwhile true; do sleep 0.1; done\n`)
    await chmod(script, 0o755)

    const result = await exec(script, [], { timeoutMs: SETUP_MS, group: true })

    expect(result).toMatchObject({ code: null, stderr: expect.stringContaining('Timed out') })
    const pid = Number(await readFile(join(dir, 'pid'), 'utf8'))
    await expect.poll(() => alive(pid), { timeout: 3000 }).toBe(false)
  }, 15_000)

  // Answering at once is bounded by the test timeout, well under the 30 s sleep
  // and the group's stop grace
  it('still answers at once for a command outside a group, and kills it', async () => {
    const script = join(dir, 'sleeper')
    await writeFile(script, `#!/bin/sh\necho $$ > '${join(dir, 'pid')}'\nexec sleep 30\n`)
    await chmod(script, 0o755)

    const result = await exec(script, [], { timeoutMs: SETUP_MS })

    expect(result).toMatchObject({ code: null, stderr: expect.stringContaining('Timed out') })
    const pid = Number(await readFile(join(dir, 'pid'), 'utf8'))
    await expect.poll(() => alive(pid)).toBe(false)
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
