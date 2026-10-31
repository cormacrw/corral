// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { clearDraftsExcept, readDraft, useDraft, writeDraft } from './useDraft'

describe('useDraft', () => {
  beforeEach(() => sessionStorage.clear())

  it('gives a new instance the text the last one left', () => {
    useDraft('plan:1').value = 'Half a thought'
    expect(useDraft('plan:1').value).toBe('Half a thought')
  })

  it('keeps each key to its own text when the key changes', () => {
    const key = ref('plan:1')
    const text = useDraft(key)
    text.value = 'First'
    key.value = 'plan:2'
    expect(text.value).toBe('')
    text.value = 'Second'
    key.value = 'plan:1'
    expect(text.value).toBe('First')
    expect(readDraft('plan:2')).toBe('Second')
  })

  it('removes an emptied draft', () => {
    const text = useDraft('plan:1')
    text.value = 'Sent'
    text.value = ''
    expect(sessionStorage.length).toBe(0)
  })

  it('stores nothing without a key', () => {
    useDraft('').value = 'Local only'
    expect(sessionStorage.length).toBe(0)
  })

  it('keeps one item\'s draft and its images, and only under that prefix', () => {
    writeDraft('inbox:a', 'Old')
    writeDraft('inbox:a:images', '[]')
    writeDraft('inbox:b', 'Current')
    writeDraft('inbox:b:images', '[]')
    writeDraft('plan:1', 'Other')
    clearDraftsExcept('inbox:', 'inbox:b')
    expect(readDraft('inbox:a')).toBe('')
    expect(readDraft('inbox:a:images')).toBe('')
    expect(readDraft('inbox:b')).toBe('Current')
    expect(readDraft('inbox:b:images')).toBe('[]')
    expect(readDraft('plan:1')).toBe('Other')
  })
})
