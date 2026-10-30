import type { RunnerMessage } from '@corral/contracts'
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerConnection } from './connection.ts'
import type { ToolHandler, ToolServer } from './mcp.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob } from './test-repo.ts'

// Stands in for `claude`: stays alive until killed, so the test can make tool
// calls while the run is active
const FAKE_CLAUDE = `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }))
setInterval(() => {}, 1000)
`
// Stands in for `ffmpeg`: logs its arguments, then writes $FAKE_FFMPEG_BYTES
// bytes to the output, its last argument, or fails when told to
const FAKE_FFMPEG = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + '\\n')
if (process.env.FAKE_FFMPEG_FAIL) {
  console.error('warning line')
  console.error(process.env.FAKE_FFMPEG_FAIL)
  process.exit(1)
}
writeFileSync(args.at(-1), Buffer.alloc(Number(process.env.FAKE_FFMPEG_BYTES ?? 4), 'm'))
`

const MB = 1024 * 1024

describe('RunManager evidence videos', () => {
  let dataDir: string
  let binDir: string
  let log: string
  let sent: RunnerMessage[]
  let manager: RunManager
  let handler: ToolHandler
  const scratch = () => join(dataDir, 'scratch', 'r1')

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    binDir = join(dirname(dataDir), 'bin')
    log = join(dirname(dataDir), 'ffmpeg.log')
    await mkdir(binDir)
    const claudeBin = join(binDir, 'claude')
    await writeFile(claudeBin, FAKE_CLAUDE)
    await writeFile(join(binDir, 'ffmpeg'), FAKE_FFMPEG)
    await chmod(claudeBin, 0o755)
    await chmod(join(binDir, 'ffmpeg'), 0o755)
    vi.stubEnv('PATH', `${binDir}:${process.env.PATH}`)
    vi.stubEnv('FAKE_FFMPEG_LOG', log)
    sent = []
    const connection = {
      send: (message: RunnerMessage) => {
        sent.push(message)
        if (message.type === 'tool.call') queueMicrotask(() => manager.handle({ type: 'tool.result', callId: message.callId, ok: true, result: {} }))
        return true
      }
    } as unknown as ServerConnection
    const tools = {
      register: (_secret: string, _role: string, h: ToolHandler) => {
        handler = h
        return () => {}
      },
      url: () => 'http://127.0.0.1:9/mcp'
    } as unknown as ToolServer
    manager = new RunManager({ dataDir, claudeBin, codexBin: 'codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 0, titleModel: 'haiku', slots: 4, roles: ['pm', 'developer', 'reviewer', 'design'] }, connection, tools)
    manager.assign(pmJob({ runId: 'r1', role: 'developer', planSessionId: null, taskId: 'task-1', taskRef: 'APP-1' }))
    await expect.poll(() => sent.some(m => m.type === 'run.started'), { timeout: 10_000 }).toBe(true)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'test' })
    await expect.poll(() => sent.some(m => m.type === 'run.ended'), { timeout: 10_000 }).toBe(true)
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  async function attach(name: string, size = 4) {
    const path = join(scratch(), name)
    await writeFile(path, Buffer.alloc(size, 'o'))
    const outcome = await handler('attach_evidence', { kind: 'video', path })
    const call = sent.find(m => m.type === 'tool.call' && m.tool === 'attach_evidence')
    return { outcome, input: call?.type === 'tool.call' ? call.input as { fileName: string, contentType: string, dataBase64: string } : null }
  }

  const original = (size = 4) => Buffer.alloc(size, 'o').toString('base64')
  const notes = async () => {
    await new Promise(r => setTimeout(r, 600))
    return sent.flatMap(m => m.type === 'run.events' ? m.events : []).flatMap(e => e.type === 'system' ? [e.text] : [])
  }
  const ffmpegRan = () => access(log).then(() => true, () => false)

  it('stores a webm as a converted mp4 and leaves no working files behind', async () => {
    const { outcome, input } = await attach('demo.webm')

    expect(outcome.ok).toBe(true)
    expect(input).toMatchObject({ fileName: 'demo.mp4', contentType: 'video/mp4', dataBase64: Buffer.alloc(4, 'm').toString('base64') })
    expect((await readdir(scratch())).filter(f => f.startsWith('evidence-'))).toEqual([])
  })

  it('asks ffmpeg for H.264/AAC with faststart', async () => {
    await attach('demo.webm')
    const args = await readFile(log, 'utf8')
    expect(args).toContain('"libx264"')
    expect(args).toContain('"aac"')
    expect(args).toContain('"+faststart"')
    expect(args).toContain('"yuv420p"')
  })

  it('does not overwrite an mp4 of the same name in the scratch folder', async () => {
    await writeFile(join(scratch(), 'demo.mp4'), 'mine')
    await attach('demo.webm')
    expect(await readFile(join(scratch(), 'demo.mp4'), 'utf8')).toBe('mine')
  })

  it('stores an mp4 byte for byte without running ffmpeg', async () => {
    const { input } = await attach('demo.mp4')

    expect(input).toMatchObject({ fileName: 'demo.mp4', contentType: 'video/mp4', dataBase64: original() })
    expect(await ffmpegRan()).toBe(false)
  })

  it('attaches the original with a note when the conversion fails', async () => {
    vi.stubEnv('FAKE_FFMPEG_FAIL', 'Invalid data found when processing input')
    const { outcome, input } = await attach('demo.webm')

    expect(outcome.ok).toBe(true)
    expect(input).toMatchObject({ fileName: 'demo.webm', contentType: 'video/webm', dataBase64: original() })
    expect(await notes()).toContain('Attaching demo.webm as it is, because it could not be converted to MP4: ffmpeg failed: Invalid data found when processing input')
  })

  it('attaches the original with a note when ffmpeg is missing', async () => {
    await rm(join(binDir, 'ffmpeg'))
    vi.stubEnv('PATH', binDir)
    const { outcome, input } = await attach('demo.webm')

    expect(outcome.ok).toBe(true)
    expect(input).toMatchObject({ fileName: 'demo.webm', contentType: 'video/webm' })
    expect(await notes()).toContain('Attaching demo.webm as it is, because it could not be converted to MP4: ffmpeg is not installed on this runner')
  })

  it('checks the limit against the converted file', async () => {
    const { outcome, input } = await attach('big.webm', 26 * MB)

    expect(outcome.ok).toBe(true)
    expect(input).toMatchObject({ fileName: 'big.mp4', contentType: 'video/mp4' })
  })

  it('keeps the original with a note when only the converted file is over the limit', async () => {
    vi.stubEnv('FAKE_FFMPEG_BYTES', String(26 * MB))
    const { input } = await attach('demo.webm')

    expect(input).toMatchObject({ fileName: 'demo.webm', contentType: 'video/webm' })
    expect(await notes()).toContain('Attaching demo.webm as it is, because it could not be converted to MP4: the MP4 is 26.0 MB, over the 25 MB limit')
  })

  it('refuses a file when neither the original nor the converted copy fits', async () => {
    vi.stubEnv('FAKE_FFMPEG_BYTES', String(26 * MB))
    const { outcome, input } = await attach('demo.webm', 26 * MB)

    expect(outcome).toEqual({ ok: false, error: 'Evidence files are limited to 25 MB, and demo.webm could not be converted to fit: the MP4 is 26.0 MB, over the 25 MB limit' })
    expect(input).toBeNull()
  })
})
