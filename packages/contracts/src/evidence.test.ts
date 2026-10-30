import { describe, expect, it } from 'vitest'
import { EVIDENCE_KINDS, evidenceInputSchema, type Evidence } from './api.ts'

describe('evidence shapes', () => {
  it('accepts note-only evidence and every D21 file kind, including empty files', () => {
    expect(evidenceInputSchema.parse({ kind: 'note', note: '  Explanation  ' })).toEqual({ kind: 'note', note: 'Explanation', criterionId: null })
    for (const kind of EVIDENCE_KINDS.filter(k => k !== 'note')) {
      expect(evidenceInputSchema.safeParse({ kind, fileName: 'file', contentType: 'application/octet-stream', dataBase64: '' }).success).toBe(true)
    }
  })

  it.each([
    { kind: 'note', note: ' \t\n' },
    { kind: 'note', note: '\u00a0\ufeff' },
    ...['fileName', 'contentType', 'dataBase64', 'blob', 'url', 'size'].map(field => ({ kind: 'note', note: 'Explanation', [field]: null })),
    ...['fileName', 'contentType', 'dataBase64'].map(field => ({ kind: 'screenshot', fileName: 'file', contentType: 'image/png', dataBase64: '', [field]: undefined })),
    { kind: 'video', fileName: ' \t', contentType: 'video/mp4', dataBase64: '' },
    { kind: 'request', fileName: 'file', contentType: '\n', dataBase64: '' },
    { kind: 'other', fileName: 'file', contentType: 'text/plain', dataBase64: '', size: -1 }
  ])('rejects invalid evidence %j', (input) => {
    expect(evidenceInputSchema.safeParse(input).success).toBe(false)
  })
})

// Compile-time regression: file metadata must narrow with the discriminator.
function fileMetadata(evidence: Evidence): string | null {
  if (evidence.kind === 'note') {
    const size: 0 = evidence.size
    const url: null = evidence.url
    return size === 0 ? url : null
  }
  const name: string = evidence.fileName
  const type: string = evidence.contentType
  return `${name}: ${type} (${evidence.url})`
}
void fileMetadata
