import { errorText } from '@corral/core'
import { useMutation } from '@tanstack/vue-query'
import type { Project } from '@corral/contracts'
import { removeProject } from '~/queries/projects'
import { projectPath, SETUP_PATH } from '~/utils/routes'

// Remove: the server wants the exact name echoed back, so the confirm button waits for it
export function useProjectRemoval(project: () => Project) {
  const removal = useMutation(removeProject)
  const router = useRouter()
  const toast = useToast()
  const { projects } = useProject()
  const open = ref(false)
  const confirm = ref('')
  const removing = useRemovingProject()
  const confirmed = computed(() => confirm.value === project().name)

  function ask() {
    confirm.value = ''
    open.value = true
  }
  async function remove() {
    const p = project()
    if (!confirmed.value) return
    removing.value = p.slug
    try {
      await removal.mutateAsync({ id: p.id, slug: p.slug, confirm: confirm.value })
      open.value = false
      toast.add({ title: `Removed ${p.name}`, color: 'success' })
      const next = projects.value?.find(x => x.id !== p.id)
      await router.push(next ? projectPath(next.slug) : SETUP_PATH)
    } catch (e) {
      toast.add({ title: 'Not removed', description: errorText(e), color: 'error' })
    } finally {
      removing.value = null
    }
  }
  return { open, confirm, confirmed, removing, ask, remove }
}
