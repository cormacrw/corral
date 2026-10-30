import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { convertToMp4 } from './evidence-video.ts'
import { exec } from './exec.ts'

vi.mock('./exec.ts', () => ({ exec: vi.fn() }))

it('limits conversion to 45 seconds and removes partial output on timeout', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'evidence-timeout-'))
  try {
    vi.mocked(exec).mockImplementation(async (_command, args, options) => {
      expect(options?.timeoutMs).toBe(45_000)
      // The upload can take another 120 seconds; leave room below Codex's
      // 180-second deadline for reading and encoding the attachment.
      expect(options!.timeoutMs! + 120_000).toBeLessThan(180_000)
      await writeFile(args.at(-1)!, 'partial MP4')
      return { code: null, stdout: '', stderr: 'Timed out after 45000 ms' }
    })

    expect(await convertToMp4(join(scratch, 'demo.webm'), scratch, 25 * 1024 * 1024))
      .toEqual({ ok: false, error: 'ffmpeg failed: Timed out after 45000 ms' })
    expect(exec).toHaveBeenCalledOnce()
    expect(await readdir(scratch)).toEqual([])
  } finally {
    vi.resetAllMocks()
    await rm(scratch, { recursive: true, force: true })
  }
})
