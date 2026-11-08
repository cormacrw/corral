import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convertToMp4 } from './evidence-video.ts'
import { exec } from './exec.ts'

vi.mock('./exec.ts', () => ({ exec: vi.fn() }))

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'evidence-timeout-'))
})

afterEach(async () => {
  vi.resetAllMocks()
  await rm(scratch, { recursive: true, force: true })
})

it('limits conversion so the upload fits Codex\'s deadline, and removes partial output on timeout', async () => {
  let timeoutMs: number | undefined
  vi.mocked(exec).mockImplementation(async (_command, args, options) => {
    timeoutMs = options?.timeoutMs
    await writeFile(args.at(-1)!, 'partial MP4')
    return { code: null, stdout: '', stderr: 'Timed out' }
  })

  expect(await convertToMp4(join(scratch, 'demo.webm'), scratch, 25 * 1024 * 1024)).toEqual({ ok: false, error: expect.stringContaining('Timed out') })
  // The upload can take another 120 seconds; leave room below Codex's
  // 180-second deadline for reading and encoding the attachment
  expect(timeoutMs! + 120_000).toBeLessThan(180_000)
  expect(await readdir(scratch)).toEqual([])
})
