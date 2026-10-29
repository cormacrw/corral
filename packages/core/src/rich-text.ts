import { marked, type Token, type Tokens } from 'marked'

// Task descriptions are rich-text documents from the editor (design/task.md),
// in the ProseMirror/TipTap JSON shape: nodes with `text` or `content`.
// The Definition of Ready only needs to know whether there's any text, so
// images (attachment nodes with no text) don't count.
export function richTextToPlainText(doc: unknown): string {
  const parts: string[] = []
  const stack: unknown[] = [doc]
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== 'object' || node === null) continue
    const { text, content } = node as { text?: unknown, content?: unknown }
    if (typeof text === 'string') parts.push(text)
    if (Array.isArray(content)) stack.push(...[...content].reverse())
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

interface RichNode {
  type: string
  attrs?: Record<string, unknown>
  content?: RichNode[]
  marks?: Mark[]
  text?: string
}
interface Mark {
  type: string
  attrs?: Record<string, unknown>
}
export type RichTextDocument = {
  type: 'doc'
  content: RichNode[]
}

// Agents write markdown (the PM's task descriptions); the editor stores
// TipTap JSON. Covers what the editor can show; anything else keeps its text.
export function markdownToRichText(markdown: string): RichTextDocument {
  return { type: 'doc', content: blocks(marked.lexer(markdown.trim())) }
}

function blocks(tokens: Token[]): RichNode[] {
  const nodes: RichNode[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'hr':
        break
      case 'heading':
        nodes.push({ type: 'heading', attrs: { level: Math.min((token as Tokens.Heading).depth, 3) }, content: inline(token.tokens ?? []) })
        break
      case 'code':
        nodes.push({ type: 'codeBlock', attrs: { language: (token as Tokens.Code).lang || null }, content: textNodes((token as Tokens.Code).text) })
        break
      case 'blockquote':
        nodes.push({ type: 'blockquote', content: blocks(token.tokens ?? []) })
        break
      case 'list': {
        const list = token as Tokens.List
        nodes.push({
          type: list.ordered ? 'orderedList' : 'bulletList',
          ...(list.ordered && { attrs: { start: typeof list.start === 'number' ? list.start : 1 } }),
          content: list.items.map(item => ({ type: 'listItem', content: listItem(item) }))
        })
        break
      }
      case 'paragraph':
      case 'text':
        nodes.push(paragraph(token.tokens ?? [{ type: 'text', raw: token.raw, text: token.raw } as Tokens.Text]))
        break
      default:
        // Tables and the like have no editor node; keep their source
        if (token.raw.trim()) nodes.push({ type: 'paragraph', content: textNodes(token.raw.trim()) })
    }
  }
  return nodes
}

// A list item needs at least one block
function listItem(item: Tokens.ListItem): RichNode[] {
  const content = blocks(item.tokens)
  return content.length > 0 ? content : [{ type: 'paragraph' }]
}

function paragraph(tokens: Token[]): RichNode {
  const content = inline(tokens)
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
}

function inline(tokens: Token[], marks: Mark[] = []): RichNode[] {
  const nodes: RichNode[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
        nodes.push(...inline(token.tokens ?? [], [...marks, { type: 'bold' }]))
        break
      case 'em':
        nodes.push(...inline(token.tokens ?? [], [...marks, { type: 'italic' }]))
        break
      case 'del':
        nodes.push(...inline(token.tokens ?? [], [...marks, { type: 'strike' }]))
        break
      case 'link':
        nodes.push(...inline(token.tokens ?? [], [...marks, { type: 'link', attrs: { href: (token as Tokens.Link).href } }]))
        break
      case 'codespan':
        nodes.push(...textNodes(unescapeHtml((token as Tokens.Codespan).text), [...marks, { type: 'code' }]))
        break
      case 'br':
        nodes.push({ type: 'hardBreak' })
        break
      case 'text':
        if (token.tokens?.length) nodes.push(...inline(token.tokens, marks))
        else nodes.push(...textNodes(unescapeHtml((token as Tokens.Text).text), marks))
        break
      default:
        if ('text' in token && typeof token.text === 'string') nodes.push(...textNodes(unescapeHtml(token.text), marks))
    }
  }
  return nodes
}

// ProseMirror rejects empty text nodes
function textNodes(text: string, marks: Mark[] = []): RichNode[] {
  if (!text) return []
  return [marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text }]
}

function unescapeHtml(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', '\'').replaceAll('&amp;', '&')
}

// Older PM descriptions were stored as one plain paragraph per markdown
// line. Those are re-read as markdown; a document with any formatting or
// structure is already the editor's and is returned as is.
export function upgradePlainMarkdown<T>(doc: T): T | RichTextDocument {
  const content = (doc as { content?: unknown } | null)?.content
  if (!Array.isArray(content) || content.length === 0) return doc
  const lines: string[] = []
  for (const node of content as RichNode[]) {
    if (node.type !== 'paragraph') return doc
    const children = node.content ?? []
    if (children.some(c => c.type !== 'text' || (c.marks?.length ?? 0) > 0)) return doc
    lines.push(children.map(c => c.text ?? '').join(''))
  }
  const text = lines.join('\n')
  if (!/^(#{1,6} |[-*+] |\d+\. |```|> )|\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/m.test(text)) return doc
  return markdownToRichText(text)
}

// The reverse, for agent prompts: structure survives as markdown where
// plain text would flatten it
export function richTextToMarkdown(doc: unknown): string {
  const content = (doc as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return (content as RichNode[]).map(blockToMarkdown).filter(Boolean).join('\n\n').trim()
}

function blockToMarkdown(node: RichNode): string {
  const children = node.content ?? []
  switch (node.type) {
    case 'heading': return `${'#'.repeat(Number(node.attrs?.level ?? 2))} ${inlineToMarkdown(children)}`
    case 'codeBlock': return `\`\`\`${typeof node.attrs?.language === 'string' ? node.attrs.language : ''}\n${children.map(c => c.text ?? '').join('')}\n\`\`\``
    case 'image': return `![${String(node.attrs?.alt ?? '').replace(/[[\]\\\r\n]/g, ' ').trim()}](${String(node.attrs?.src ?? '')})`
    case 'blockquote': return children.map(blockToMarkdown).join('\n\n').split('\n').map(line => `> ${line}`).join('\n')
    case 'bulletList':
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return children.map((item, i) => {
        const bullet = node.type === 'orderedList' ? `${start + i}. ` : '- '
        const body = (item.content ?? []).map(blockToMarkdown).join('\n')
        return bullet + body.split('\n').join(`\n${' '.repeat(bullet.length)}`)
      }).join('\n')
    }
    default: return inlineToMarkdown(children)
  }
}

function inlineToMarkdown(nodes: RichNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '\n'
    let text = node.text ?? ''
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') text = `**${text}**`
      else if (mark.type === 'italic') text = `*${text}*`
      else if (mark.type === 'strike') text = `~~${text}~~`
      else if (mark.type === 'code') text = `\`${text}\``
      else if (mark.type === 'link') text = `[${text}](${String(mark.attrs?.href ?? '')})`
    }
    return text
  }).join('')
}
