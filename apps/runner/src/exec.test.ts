import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exec, STOP_GRACE_MS, type ExecResult } from './exec.ts'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const TIMEOUT_MS = 1000

describe('exec', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'corral-exec-'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  // Runs a script that calls `ready` once it has set itself up (its trap, its
  // helpers), then fires the timeout. The timeout runs on fake time, so a busy
  // machine can't fire it before the script is ready.
  async function timeOut(body: string, options: { group?: boolean } = {}): Promise<{ result: Promise<ExecResult> }> {
    const script = join(dir, 'script')
    await writeFile(script, `#!/bin/sh\n${body}\n`)
    await chmod(script, 0o755)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = exec(script, [], { timeoutMs: TIMEOUT_MS, ...options })
    await expect.poll(() => stat(join(dir, 'ready')).then(() => true, () => false)).toBe(true)
    vi.advanceTimersByTime(TIMEOUT_MS)
    return { result }
  }
  // Writes the file whole, so it's never read half written
  const ready = (pid: string) => `echo ${pid} > '${join(dir, 'pid')}' && mv '${join(dir, 'pid')}' '${join(dir, 'ready')}'`
  const pid = async () => Number(await readFile(join(dir, 'ready'), 'utf8'))

  it('reports a timeout and stops the whole group', async () => {
    const { result } = await timeOut(`sleep 30 &\n${ready('$!')}\nwait`, { group: true })

    expect(await result).toMatchObject({ code: null, stderr: expect.stringContaining(`Timed out after ${TIMEOUT_MS} ms`) })
    const helper = await pid()
    await expect.poll(() => alive(helper)).toBe(false)
  })

  it('lets a group clean up on SIGTERM before it answers', async () => {
    const lock = join(dir, 'index.lock')
    const { result } = await timeOut(`touch '${lock}'\ntrap "rm -f '${lock}'; exit 1" TERM\nsleep 30 &\n${ready('')}\nwait`, { group: true })

    expect((await result).code).toBeNull()
    expect(await stat(lock).catch(() => null)).toBeNull()
  })

  it('kills a group that ignores SIGTERM after the grace period', async () => {
    const { result } = await timeOut(`trap '' TERM\n${ready('$$')}\nwhile true; do sleep 0.1; done`, { group: true })
    const stubborn = await pid()
    vi.advanceTimersByTime(STOP_GRACE_MS)

    expect(await result).toMatchObject({ code: null, stderr: expect.stringContaining('Timed out') })
    await expect.poll(() => alive(stubborn)).toBe(false)
  })

  it('still answers at once for a command outside a group, and kills it', async () => {
    const { result } = await timeOut(`${ready('$$')}\nexec sleep 30`)

    // No grace period passes on the fake clock, so only an answer at once arrives
    expect(await result).toMatchObject({ code: null, stderr: expect.stringContaining('Timed out') })
    const sleeper = await pid()
    await expect.poll(() => alive(sleeper)).toBe(false)
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
