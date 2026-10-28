import type { Token } from 'marked'
import { marked } from 'marked'

// One-line previews of agent markdown: the words, without the syntax
export function markdownToPlainText(markdown: string): string {
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
