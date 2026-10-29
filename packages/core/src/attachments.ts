// Images in task text are attachments: markdown writes them as
// ![name](attachment:<id>), and the editor's image nodes carry either that
// or the URL the server serves them from.
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const REFERENCE = new RegExp(`^(?:attachment:(${ID})|(?:[a-z][a-z0-9+.-]*://[^/]+)?/api/attachments/(${ID})/file(?:[?#].*)?)$`, 'i')
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g

export function attachmentUrl(id: string): string {
  return `/api/attachments/${id}/file`
}

// The attachment an image source points at, or null for any other image
export function attachmentIdFromSrc(src: string): string | null {
  const match = REFERENCE.exec(src.trim())
  const id = match?.[1] ?? match?.[2]
  return id ? id.toLowerCase() : null
}

// Each attachment referenced by a markdown image, once, in order
export function attachmentIdsInMarkdown(markdown: string): string[] {
  const ids = new Set<string>()
  for (const match of markdown.matchAll(MARKDOWN_IMAGE)) {
    const id = attachmentIdFromSrc(match[1]!)
    if (id) ids.add(id)
  }
  return [...ids]
}

// The same for a rich-text document: image nodes whose src is an attachment
export function attachmentIdsInRichText(doc: unknown): string[] {
  const ids = new Set<string>()
  const stack: unknown[] = [doc]
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== 'object' || node === null) continue
    const { type, attrs, content } = node as { type?: unknown, attrs?: { src?: unknown }, content?: unknown }
    if (type === 'image' && typeof attrs?.src === 'string') {
      const id = attachmentIdFromSrc(attrs.src)
      if (id) ids.add(id)
    }
    if (Array.isArray(content)) stack.push(...[...content].reverse())
  }
  return [...ids]
}
