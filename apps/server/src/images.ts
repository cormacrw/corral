import { IMAGE_CONTENT_TYPES, imageTooLarge, UNSUPPORTED_IMAGE, type ImageContentType } from '@corral/contracts'
import { ApiFailure } from './errors.ts'

// The image types Corral stores (avatars and attachments). Never SVG: it can
// carry script, and nothing here serves it.
const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.slice(start, end))
const SIGNATURES: Record<ImageContentType, (b: Uint8Array) => boolean> = {
  'image/png': b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
  'image/jpeg': b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  'image/webp': b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'image/gif': b => ascii(b, 0, 4) === 'GIF8'
}

// The declared type, if it's one we take: the content-type header without parameters
export function declaredImageType(contentType: string | undefined): ImageContentType | null {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase() as ImageContentType
  return IMAGE_CONTENT_TYPES.includes(type) ? type : null
}

// Whether the file's first bytes are really that type, so a mislabelled
// upload can't be served as an image
export function hasImageSignature(data: Uint8Array, type: ImageContentType): boolean {
  return SIGNATURES[type](data)
}

// An uploaded image Corral will keep: a type it takes, really of that type,
// and no bigger than `maxBytes`. Refusals name the request's `field`.
export function validateImage(data: Uint8Array, contentType: string | undefined, { maxBytes, field }: { maxBytes: number, field: string }): ImageContentType {
  const invalid = (message: string, status: 400 | 413 = 400) => new ApiFailure(status, { code: 'invalid_input', issues: [{ path: [field], message }] })
  const type = declaredImageType(contentType)
  if (!type) throw invalid(UNSUPPORTED_IMAGE)
  if (data.byteLength === 0) throw invalid('The image is empty')
  if (data.byteLength > maxBytes) throw invalid(imageTooLarge(maxBytes), 413)
  if (!hasImageSignature(data, type)) throw invalid(`The file isn't a ${type.slice(6).toUpperCase()} image`)
  return type
}
