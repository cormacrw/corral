import type { Token } from 'marked'
import { marked } from 'marked'

// A list re-renders on every keystroke in a composer beside it, and its rows
// repeat. Oldest out first, which is enough for a list's worth of previews.
const PREVIEW_CACHE = 1000
const previews = new Map<string, string>()

// One-line previews of agent markdown: the words, without the syntax
export function markdownToPlainText(markdown: string): string {
  const known = previews.get(markdown)
  if (known !== undefined) return known
  const plain = plainText(markdown)
  if (previews.size >= PREVIEW_CACHE) previews.delete(previews.keys().next().value!)
  previews.set(markdown, plain)
  return plain
}

function plainText(markdown: string): string {
  const parts: string[] = []
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      if ('tokens' in token && token.tokens?.length) walk(token.tokens)
      else if (token.type === 'list') walk(token.items)
      else if ('text' in token && typeof token.text === 'string') parts.push(token.text)
      else if (token.type === 'space' || token.type === 'br') parts.push(' ')
    }
  }
  walk(marked.lexer(markdown))
  return parts.join(' ').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', '\'').replace(/\s+/g, ' ').trim()
}
