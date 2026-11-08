import type { Attachment } from '@corral/contracts'
import { api } from '~/queries/api'
import { defineMutation } from './dependencies'

// Nothing lists a project's attachments, so an upload leaves nothing stale
export const uploadAttachment = defineMutation<Attachment, { slug: string, file: Blob, name: string }>({
  mutationFn: ({ slug, file, name }) => api.attachments.upload(slug, file, name),
  invalidates: []
})
