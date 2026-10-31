// Evidence is the agent's file, with a type and name it chose, served from
// Corral's own origin. Only types a browser can't run are served inline.
// PDFs stay inline for the viewer's iframe, whose plugin refuses a sandboxed
// document and doesn't reach the page's origin.
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp)|video\/[a-z0-9.+-]+|text\/plain|application\/pdf)$/
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/

export function evidenceHeaders(contentType: string | null, fileName: string | null): Record<string, string> {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const inline = INLINE_TYPES.test(type)
  return {
    // Kept when served as an attachment: <img> needs it for an SVG, which
    // can't run from there
    'content-type': type === 'text/plain' ? 'text/plain; charset=utf-8' : MEDIA_TYPE.test(type) ? type : 'application/octet-stream',
    'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', fileName ?? 'evidence'),
    'x-content-type-options': 'nosniff',
    ...(type !== 'application/pdf' && { 'content-security-policy': 'sandbox' }),
    // Blobs are immutable, so they can be cached forever
    'cache-control': 'private, max-age=31536000, immutable'
  }
}

// RFC 6266: a plain name where one will do, with an RFC 5987 one beside its
// ASCII stand-in otherwise. A header can't carry control characters.
function contentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const name = fileName.toWellFormed().replace(/[\p{Cc}"\\]/gu, '')
  const ascii = name.replace(/[^\x20-\x7e]/g, '_')
  if (ascii === name) return `${disposition}; filename="${name}"`
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
