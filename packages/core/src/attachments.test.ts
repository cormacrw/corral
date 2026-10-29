import { describe, expect, it } from 'vitest'
import { attachmentIdFromSrc, attachmentIdsInMarkdown, attachmentIdsInRichText, attachmentUrl } from './attachments.ts'

const a = '0b7c6f1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e'
const b = '9f8e7d6c-5b4a-4321-8fed-cba987654321'

describe('attachmentIdFromSrc', () => {
  it('reads attachment: references and attachment URLs', () => {
    expect(attachmentIdFromSrc(`attachment:${a}`)).toBe(a)
    expect(attachmentIdFromSrc(attachmentUrl(a))).toBe(a)
    expect(attachmentIdFromSrc(`https://corral.example.com/api/attachments/${a}/file?x=1`)).toBe(a)
    expect(attachmentIdFromSrc(`attachment:${a.toUpperCase()}`)).toBe(a)
  })

  it('ignores other images and malformed ids', () => {
    expect(attachmentIdFromSrc('https://example.com/cat.png')).toBeNull()
    expect(attachmentIdFromSrc('attachment:not-an-id')).toBeNull()
    expect(attachmentIdFromSrc(`/api/attachments/${a}/other`)).toBeNull()
    expect(attachmentIdFromSrc(`xattachment:${a}`)).toBeNull()
  })
})

describe('attachmentIdsInMarkdown', () => {
  it('returns each referenced attachment once, in order', () => {
    const markdown = [
      `Before ![login screen](attachment:${b}) and after.`,
      `![](attachment:${a} "with a title")`,
      `![again](attachment:${b})`,
      `![by url](${attachmentUrl(a)})`
    ].join('\n\n')
    expect(attachmentIdsInMarkdown(markdown)).toEqual([b, a])
  })

  it('ignores links, other images and plain text', () => {
    const markdown = `[a link](attachment:${a}) ![remote](https://x.dev/a.png) attachment:${b}`
    expect(attachmentIdsInMarkdown(markdown)).toEqual([])
    expect(attachmentIdsInMarkdown('')).toEqual([])
  })
})

describe('attachmentIdsInRichText', () => {
  it('finds image nodes anywhere in the document', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: `attachment:${b}` }] },
        { type: 'image', attrs: { src: `attachment:${a}`, alt: 'one' } },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'image', attrs: { src: `/api/attachments/${b}/file` } }] }] },
        { type: 'image', attrs: { src: 'https://example.com/cat.png' } },
        { type: 'image', attrs: { src: `attachment:${a}` } },
        { type: 'image' }
      ]
    }
    expect(attachmentIdsInRichText(doc)).toEqual([a, b])
  })

  it('handles empty and missing documents', () => {
    expect(attachmentIdsInRichText({ type: 'doc', content: [] })).toEqual([])
    expect(attachmentIdsInRichText(null)).toEqual([])
  })
})
