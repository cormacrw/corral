import { errorText } from '@corral/core'
import { useMutation } from '@tanstack/vue-query'
import type { Project } from '@corral/contracts'
import { IMAGE_CONTENT_TYPES, imageTooLarge, THUMBNAIL_MAX_BYTES } from '@corral/contracts/client'
import { setProjectThumbnail } from '~/queries/projects'
import { IMAGE_ACCEPT } from '~/utils/attachments'

// A project's thumbnail image, which applies immediately rather than with Save
export function useProjectThumbnailUpload(project: () => Project) {
  const thumbnail = useMutation(setProjectThumbnail)
  const toast = useToast()
  const busy = ref(false)

  async function change(image: File | null) {
    if (busy.value) return
    busy.value = true
    try {
      await thumbnail.mutateAsync({ slug: project().slug, image })
    } catch (e) {
      toast.add({ title: image ? 'Image not uploaded' : 'Image not removed', description: errorText(e), color: 'error' })
    } finally {
      busy.value = false
    }
  }
  function upload(file: File) {
    const error = !(IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type)
      ? 'Choose a PNG, JPEG, WebP or GIF image.'
      : file.size > THUMBNAIL_MAX_BYTES ? `${imageTooLarge(THUMBNAIL_MAX_BYTES)}.` : null
    if (error) toast.add({ title: 'Image not uploaded', description: error, color: 'error' })
    else void change(file)
  }
  return { busy, accept: IMAGE_ACCEPT, upload, remove: () => change(null) }
}
