import { describe, expect, it } from 'vitest'
import { richTextToPlainText } from './rich-text.ts'

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
})
