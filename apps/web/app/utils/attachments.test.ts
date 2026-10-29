import { attachmentIdsInMarkdown } from '@corral/core'
import { describe, expect, it } from 'vitest'
import { attachmentProblem, withAttachments } from './attachments.ts'

const ID = '0b8f5d3e-1c2a-4f6b-9d7e-8a1b2c3d4e5f'
const OTHER = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'

describe('attachmentProblem', () => {
  it('accepts the raster types the server stores', () => {
    expect(attachmentProblem({ type: 'image/png', size: 10 })).toBeNull()
    expect(attachmentProblem({ type: 'image/webp', size: 10 })).toBeNull()
  })

  it('rejects other types, empty files and files over 10 MB', () => {
    expect(attachmentProblem({ type: 'image/svg+xml', size: 10 })).toMatch(/PNG, JPEG/)
    expect(attachmentProblem({ type: 'application/pdf', size: 10 })).toMatch(/PNG, JPEG/)
    expect(attachmentProblem({ type: 'image/png', size: 10 * 1024 * 1024 + 1 })).toMatch(/over 10 MB/)
    expect(attachmentProblem({ type: 'image/png', size: 0 })).toMatch(/empty/)
  })
})

describe('withAttachments', () => {
  it('appends an image reference for each attachment', () => {
    const text = withAttachments(' Look at this ', [{ id: ID, name: 'shot.png' }, { id: OTHER, name: 'two.jpg' }])
    expect(text).toBe(`Look at this\n\n![shot.png](attachment:${ID}) ![two.jpg](attachment:${OTHER})`)
    expect(attachmentIdsInMarkdown(text)).toEqual([ID, OTHER])
  })

  it('sends an image on its own', () => {
    expect(withAttachments('', [{ id: ID, name: 'shot.png' }])).toBe(`![shot.png](attachment:${ID})`)
  })

  it('keeps names from breaking the markdown', () => {
    const text = withAttachments('', [{ id: ID, name: 'a]b[\nc.png' }, { id: OTHER, name: '' }])
    expect(text).toBe(`![a b c.png](attachment:${ID}) ![image](attachment:${OTHER})`)
    expect(attachmentIdsInMarkdown(text)).toEqual([ID, OTHER])
  })

  it('leaves text without images alone', () => {
    expect(withAttachments('hi', [])).toBe('hi')
  })
})
