import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalBlobStore } from './blob-store.ts'
import { Transcripts } from './transcripts.ts'

const line = (text: string) => ({ type: 'system' as const, text })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'corral-transcripts-'))
  const blobs = new LocalBlobStore(join(dir, 'blobs'))
  return { dir, blobs, transcripts: new Transcripts(join(dir, 'spool'), blobs) }
}

describe('Transcripts.append', () => {
  it('returns where the lines land, whatever overlaps', async () => {
    const { transcripts } = await setup()
    expect(await transcripts.append('r1', [line('a'), line('b')])).toBe(0)
    const offsets = await Promise.all([
      transcripts.append('r1', [line('c')]), transcripts.append('r1', [line('d'), line('e')]), transcripts.append('r1', [line('f')])
    ])
    expect(offsets).toEqual([2, 3, 5])
    expect(await transcripts.append('r2', [line('other run')])).toBe(0)
    expect((await transcripts.read('r1', null)).map(e => 'text' in e && e.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('carries on from the spool after a restart', async () => {
    const { dir, blobs, transcripts } = await setup()
    await transcripts.append('r1', [line('a'), line('b')])
    expect(await new Transcripts(join(dir, 'spool'), blobs).append('r1', [line('c')])).toBe(2)
  })
})
