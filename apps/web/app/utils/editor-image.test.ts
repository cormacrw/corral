import { describe, expect, it } from 'vitest'
import { shownImageSrc, storedImageSrc } from './editor-image'

const id = '0d6f7c2e-5b1a-4c3d-9e8f-1a2b3c4d5e6f'

describe('description images', () => {
  it('stores attachments as attachment:<id>, wherever they were copied from', () => {
    expect(storedImageSrc(`attachment:${id}`)).toBe(`attachment:${id}`)
    expect(storedImageSrc(`/api/attachments/${id}/file`)).toBe(`attachment:${id}`)
    expect(storedImageSrc(`https://corral.example.com/api/attachments/${id}/file`)).toBe(`attachment:${id}`)
  })

  it('shows attachments from the server', () => {
    expect(shownImageSrc(`attachment:${id}`)).toBe(`/api/attachments/${id}/file`)
  })

  it('leaves other images alone', () => {
    expect(storedImageSrc('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(shownImageSrc('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(storedImageSrc(null)).toBeNull()
  })
})
