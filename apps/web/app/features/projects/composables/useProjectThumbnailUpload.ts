import { errorMessage } from '~/lib/errors'
import { useMutation } from '@tanstack/vue-query'
import type { Project } from '@corral/contracts'
import { setProjectThumbnail } from '~/queries/projects'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

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
      toast.add({ title: image ? 'Image not uploaded' : 'Image not removed', description: errorMessage(e), color: 'error' })
    } finally {
      busy.value = false
    }
  }
  function upload(file: File) {
    const error = !IMAGE_TYPES.includes(file.type)
      ? 'Choose a PNG, JPEG, WebP or GIF image.'
      : file.size > MAX_IMAGE_BYTES ? 'The image is over 2 MB.' : null
    if (error) toast.add({ title: 'Image not uploaded', description: error, color: 'error' })
    else void change(file)
  }
  return { busy, accept: IMAGE_TYPES.join(','), upload, remove: () => change(null) }
}
