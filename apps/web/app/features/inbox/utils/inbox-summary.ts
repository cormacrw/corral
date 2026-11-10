import { clip } from '@corral/core'
import { markdownToPlainText } from '~/utils/markdown'

// Items with no stored message: the first paragraph of the body, plain
export function inboxTldr(body: string) {
  const first = body.split(/\n\s*\n/).find(p => p.trim() && !p.trim().startsWith('#')) ?? body
  const plain = markdownToPlainText(first).replace(/\s+/g, ' ').trim()
  return clip(plain, 180)
}

export const verdictMark = (approved: boolean) => approved
  ? { icon: 'i-hugeicons-checkmark-circle-02', color: 'text-success' }
  : { icon: 'i-hugeicons-alert-circle', color: 'text-warning' }
