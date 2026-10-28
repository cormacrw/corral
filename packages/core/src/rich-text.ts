// Task descriptions are rich-text documents from the editor (design/task.md),
// in the ProseMirror/TipTap JSON shape: nodes with `text` or `content`.
// The Definition of Ready only needs to know whether there's any text.
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
