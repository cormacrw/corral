import { ATTACHMENT_CONTENT_TYPES, ATTACHMENT_MAX_BYTES } from '@corral/contracts'

// Why a file can't be attached, or null when it can. The server checks
// again; this saves uploading something it would reject.
export function attachmentProblem(file: { type: string, size: number }): string | null {
  if (!(ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(file.type)) return 'Use a PNG, JPEG, WebP or GIF image'
  if (file.size > ATTACHMENT_MAX_BYTES) return 'The image is over 10 MB'
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
