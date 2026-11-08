import { attachmentIdFromSrc, attachmentUrl } from '@corral/core'
import { ATTACHMENT_MAX_BYTES, IMAGE_CONTENT_TYPES, imageTooLarge, UNSUPPORTED_IMAGE } from '@corral/contracts/client'

// The file picker's accept list
export const IMAGE_ACCEPT = IMAGE_CONTENT_TYPES.join(',')

// Why a file can't be attached, or null when it can. The server checks
// again; this saves uploading something it would reject.
export function attachmentProblem(file: { type: string, size: number }): string | null {
  if (!(IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type)) return UNSUPPORTED_IMAGE
  if (file.size > ATTACHMENT_MAX_BYTES) return imageTooLarge(ATTACHMENT_MAX_BYTES)
  if (file.size === 0) return 'The image is empty'
  return null
}

// The message as sent: the text, then ![name](attachment:<id>) for each
// image, so messages and comments keep their plain-text shape. The images
// share a paragraph, so they show side by side.
export function withAttachments(text: string, images: { id: string, name: string }[]): string {
  const alt = (name: string) => name.replace(/[[\]\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'image'
  return [text.trim(), images.map(image => `![${alt(image.name)}](attachment:${image.id})`).join(' ')].filter(Boolean).join('\n\n')
}

// The src an image node stores: attachment:<id> for an attachment, however
// it arrived (pasted from another description, copied as a host URL), so
// saved descriptions don't depend on where Corral is served from
export function storedImageSrc(src: string | null): string | null {
  if (!src) return src
  const id = attachmentIdFromSrc(src)
  return id ? `attachment:${id}` : src
}

// The src the browser loads
export function shownImageSrc(src: string | null): string | null {
  if (!src) return src
  const id = attachmentIdFromSrc(src)
  return id ? attachmentUrl(id) : src
}
