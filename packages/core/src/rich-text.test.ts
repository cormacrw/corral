import { describe, expect, it } from 'vitest'
import { markdownToRichText, richTextToMarkdown, richTextToPlainText, upgradePlainMarkdown } from './rich-text.ts'

describe('richTextToPlainText', () => {
  it('joins text nodes in document order', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Email' }, { type: 'text', text: 'and password' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'login' }] }] }] }
      ]
    }
    expect(richTextToPlainText(doc)).toBe('Email and password login')
  })

  it('returns an empty string for an empty or missing document', () => {
    expect(richTextToPlainText({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('')
    expect(richTextToPlainText(null)).toBe('')
  })

  it('ignores images, which carry no text', () => {
    const image = { type: 'image', attrs: { src: 'attachment:0d6f7c2e-5b1a-4c3d-9e8f-1a2b3c4d5e6f', alt: 'screenshot.png' } }
    expect(richTextToPlainText({ type: 'doc', content: [image, { type: 'paragraph' }] })).toBe('')
  })
})

describe('markdownToRichText', () => {
  it('turns headings, marks, lists and code into editor nodes', () => {
    const doc = markdownToRichText('## Goal\n\nAdd a **shared** header from `app.vue` & [docs](https://x.dev).\n\n- Home\n- Hello\n\n1. one\n\n```ts\nconst a = 1 < 2\n```')
    expect(doc.content.map(n => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList', 'codeBlock'])
    expect(doc.content[0]).toEqual({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] })
    expect(doc.content[1]!.content).toEqual([
      { type: 'text', text: 'Add a ' },
      { type: 'text', text: 'shared', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' header from ' },
      { type: 'text', text: 'app.vue', marks: [{ type: 'code' }] },
      { type: 'text', text: ' & ' },
      { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://x.dev' } }] },
      { type: 'text', text: '.' }
    ])
    expect(doc.content[2]!.content![1]).toEqual({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] })
    expect(doc.content[4]).toEqual({ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1 < 2' }] })
  })

  it('round-trips through richTextToMarkdown', () => {
    const markdown = '## Goal\n\nAdd a **shared** header.\n\n- Home\n- Hello\n\n```ts\nconst a = 1\n```'
    expect(richTextToMarkdown(markdownToRichText(markdown))).toBe(markdown)
  })

  it('does not interpret extension metadata as an ordered-list start on bullet lists', () => {
    expect(richTextToMarkdown({ type: 'doc', content: [{
      type: 'bulletList', attrs: { start: { toString: null } },
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }]
    }] })).toBe('- Item')
  })

  it('writes images as markdown images', () => {
    const doc = { type: 'doc', content: [{ type: 'image', attrs: { src: 'attachment:0d6f7c2e-5b1a-4c3d-9e8f-1a2b3c4d5e6f', alt: 'the [login] page' } }] }
    expect(richTextToMarkdown(doc)).toBe('![the  login  page](attachment:0d6f7c2e-5b1a-4c3d-9e8f-1a2b3c4d5e6f)')
  })
})

describe('upgradePlainMarkdown', () => {
  const plain = (...lines: string[]) => ({ type: 'doc', content: lines.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) })

  it('re-reads markdown stored as one plain paragraph per line', () => {
    expect(upgradePlainMarkdown(plain('## Goal', '- one', '- two'))).toEqual(markdownToRichText('## Goal\n- one\n- two'))
  })

  it('leaves prose and formatted documents alone', () => {
    const prose = plain('Just a sentence.')
    expect(upgradePlainMarkdown(prose)).toBe(prose)
    const formatted = markdownToRichText('## Already **rich**')
    expect(upgradePlainMarkdown(formatted)).toBe(formatted)
    expect(upgradePlainMarkdown(null)).toBe(null)
  })
})

describe('malformed stored rich text', () => {
  it.each([
    [null, 'content[0]'],
    [42, 'content[0]'],
    [[], 'content[0]'],
    [{}, 'content[0].type'],
    [{ type: 'paragraph', content: {} }, 'content[0].content'],
    [{ type: 'text', text: 7 }, 'content[0].text'],
    [{ type: 'text' }, 'content[0].text'],
    [{ type: 'text', text: 'x', marks: {} }, 'content[0].marks'],
    [{ type: 'text', text: 'x', marks: [null] }, 'content[0].marks[0]'],
    [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: {} } }] }, 'content[0].marks[0].attrs.href'],
    [{ type: 'image', attrs: { src: {} } }, 'content[0].attrs.src'],
    [{ type: 'codeBlock', attrs: { language: [] } }, 'content[0].attrs.language'],
    [{ type: 'heading', attrs: { level: -1 } }, 'content[0].attrs.level'],
    [{ type: 'orderedList', attrs: { start: '2' } }, 'content[0].attrs.start'],
    [{ type: 'paragraph', attrs: [] }, 'content[0].attrs']
  ])('reports a contextual path for %j', (child, path) => {
    const doc = { type: 'doc', content: [child] }
    for (const reader of [richTextToMarkdown, richTextToPlainText, upgradePlainMarkdown]) {
      expect(() => reader(doc)).toThrow(`invalid rich text at description.${path}`)
      try {
        reader(doc)
      } catch (error) {
        expect(error).not.toBeInstanceOf(TypeError)
      }
    }
  })
})
