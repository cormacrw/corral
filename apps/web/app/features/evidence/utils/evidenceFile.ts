import type { Evidence } from '@corral/contracts'

type Typed = Pick<Evidence, 'contentType'>

export const isImage = (e: Typed) => !!e.contentType?.startsWith('image/')
export const isVideo = (e: Typed) => !!e.contentType?.startsWith('video/')
// Logs, test output and requests: shown as text in the app's theme, not in
// an iframe where the browser picks its own colours
export const isText = (e: Typed) => !!e.contentType && (e.contentType.startsWith('text/') || /json|xml|yaml/.test(e.contentType))
// Evidence is untrusted: an iframe would run HTML in the app's origin, so only
// a PDF goes in one. Anything else that isn't shown above is a download.
export const isPdf = (e: Typed) => !!e.contentType?.startsWith('application/pdf')
export const kindLabel = (kind: Evidence['kind']) => kind.replace('_', ' ')
