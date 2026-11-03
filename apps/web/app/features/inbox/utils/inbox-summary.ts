import { markdownToPlainText } from '~/utils/markdown'

// Items with no stored message: the first paragraph of the body, plain
export function inboxTldr(body: string) {
  const first = body.split(/\n\s*\n/).find(p => p.trim() && !p.trim().startsWith('#')) ?? body
  const plain = markdownToPlainText(first).replace(/\s+/g, ' ').trim()
  return plain.length > 180 ? `${plain.slice(0, 177).trimEnd()}…` : plain
}

// A review's verdict at a glance
export const verdictMark = (approved: boolean) => approved
  ? { icon: 'i-ri-checkbox-circle-line', color: 'text-success' }
  : { icon: 'i-ri-error-warning-line', color: 'text-warning' }
