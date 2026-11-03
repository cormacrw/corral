import { errorMessage } from '~/lib/errors'
import { useMutation } from '@tanstack/vue-query'
import type { PatchProjectInput, Project } from '@corral/contracts'
import { DEFAULT_LIMITS } from '@corral/core'
import { ApiError } from '~/queries/client'
import { patchProject } from '~/queries/projects'

type SettingsForm = Required<Omit<PatchProjectInput, 'paused'>>

const formOf = (p: Project): SettingsForm => ({ name: p.name, prefix: p.prefix, thumbnailColor: p.thumbnailColor, defaultBranch: p.defaultBranch, mergeMethod: p.mergeMethod, requiredChecks: [...p.requiredChecks], humanReviewDefault: p.humanReviewDefault, epicReviewModeDefault: p.epicReviewModeDefault, reviewRoundCap: p.reviewRoundCap, failedRunCap: p.failedRunCap })

// Project settings (design/project-settings.md): form fields save together;
// pause applies immediately.
export function useProjectSettings() {
  const patch = useMutation(patchProject)
  const toast = useToast()
  const { slug, project } = useProject()

  const form = reactive<SettingsForm>({
    name: '', prefix: '', thumbnailColor: null, defaultBranch: 'main', mergeMethod: 'squash', requiredChecks: [], humanReviewDefault: false, epicReviewModeDefault: 'epic', ...DEFAULT_LIMITS
  })
  watch(project, (p, previous) => {
    if (!p) return
    // Immediate image writes and live events must not discard unsaved fields.
    const edits = previous?.id === p.id
      ? Object.fromEntries(Object.entries(form).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof Project])))
      : {}
    Object.assign(form, formOf(p), edits)
  }, { immediate: true })

  const prefixValid = computed(() => /^[A-Z]{2,5}$/.test(form.prefix))
  const dirty = computed(() => project.value ? JSON.stringify(form) !== JSON.stringify(formOf(project.value)) : false)
  const canSave = computed(() => dirty.value && prefixValid.value && Boolean(form.name.trim()))
  const saving = ref(false)
  const saved = ref(false)
  const prefixConflict = ref('')
  const prefixError = computed(() => prefixConflict.value || (prefixValid.value ? undefined : 'Use 2–5 letters, A–Z.'))

  async function save() {
    if (!project.value) return
    saving.value = true
    prefixConflict.value = ''
    try {
      await patch.mutateAsync({ slug: slug.value, input: { ...form } })
      saved.value = true
      setTimeout(() => {
        saved.value = false
      }, 1800)
    } catch (e) {
      if (e instanceof ApiError && e.body?.code === 'conflict' && e.body.constraint?.includes('prefix')) prefixConflict.value = 'Another project uses this prefix.'
      else toast.add({ title: 'Not saved', description: errorMessage(e), color: 'error' })
    } finally {
      saving.value = false
    }
  }
  async function setPaused(paused: boolean) {
    if (!project.value) return
    try {
      await patch.mutateAsync({ slug: slug.value, input: { paused } })
    } catch (e) {
      toast.add({ title: 'Could not change pause', description: errorMessage(e), color: 'error' })
    }
  }

  return { form, prefixError, canSave, saving, saved, save, setPaused }
}

export type ProjectSettings = ReturnType<typeof useProjectSettings>
