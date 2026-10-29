import { ATTACHMENT_CONTENT_TYPES, type AttachmentContentType } from '@corral/contracts'

// The image types Corral stores (avatars and attachments). Never SVG: it can
// carry script, and nothing here serves it.
const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.slice(start, end))
const SIGNATURES: Record<AttachmentContentType, (b: Uint8Array) => boolean> = {
  'image/png': b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
  'image/jpeg': b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  'image/webp': b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'image/gif': b => ascii(b, 0, 4) === 'GIF8'
}

// The declared type, if it's one we take: the content-type header without parameters
export function declaredImageType(contentType: string | undefined): AttachmentContentType | null {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase() as AttachmentContentType
  return ATTACHMENT_CONTENT_TYPES.includes(type) ? type : null
}

// Whether the file's first bytes are really that type, so a mislabelled
// upload can't be served as an image
export function hasImageSignature(data: Uint8Array, type: AttachmentContentType): boolean {
  return SIGNATURES[type](data)
}
