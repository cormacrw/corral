import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { AgentRuntime } from '@corral/contracts'
import { useDraft } from '~/composables/useDraft'
import { clisQuery } from '~/queries/setup'
import { detectedRuntimes, runtimeLabel } from '~/utils/labels'

const ATTACHED_IMAGE = /!\[([^\]]*)\]\(attachment:([^)]*)\)/g

// A new Plan session before it starts (design/plan.md): the project, runtime,
// draft and attached task, restored when a failed start comes back to the prompt.
export function usePlanStart(initialProjectId: () => string | undefined) {
  const shell = useShell()
  const router = useRouter()
  const pending = usePendingPlan()

  const lastProject = useLocalStorage<string | null>('corral.plan.project', null)
  const projectId = ref<string | null>(initialProjectId() ?? lastProject.value)
  const project = computed(() => shell.projects.find(p => p.id === projectId.value) ?? null)
  watch(project, (p) => {
    lastProject.value = p?.id ?? null
  }, { immediate: true })

  // The PM's runtime for the new session (D18): only CLIs the runner has.
  // Until the runner answers, Claude is the one on offer.
  const { data: clis } = useQuery(computed(() => ({ ...clisQuery(), enabled: Boolean(shell.runner?.online) })))
  const runtimes = computed(() => {
    const found = detectedRuntimes(clis.value ?? [])
    return found.length > 0 ? found : ['claude-code' as const]
  })
  const runtimeItems = computed(() => runtimes.value.map(r => ({ label: runtimeLabel(r), value: r })))
  const lastRuntime = useLocalStorage<AgentRuntime>('corral.plan.runtime', 'claude-code')
  const runtime = computed<AgentRuntime>(() => runtimes.value.includes(lastRuntime.value) ? lastRuntime.value : runtimes.value[0]!)

  const restored = pending.restored.value
  pending.restored.value = null
  if (restored) {
    projectId.value = restored.session.projectId
    lastRuntime.value = restored.session.runtime
  }
  const restoredImages = [...(restored?.message ?? '').matchAll(ATTACHED_IMAGE)].map(m => ({ name: m[1]!, id: m[2]! }))
  const text = useDraft('plan:new')
  if (restored) text.value = restored.message.replace(ATTACHED_IMAGE, '').trim()
  const taskRef = ref<string | null>(restored?.taskRef ?? null)
  watch(projectId, () => {
    taskRef.value = null
  })

  const busy = ref(false)
  // Resolves false when not started, so the composer keeps its images
  async function start(message: string): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    const id = pending.seed(project.value?.id ?? null, message, runtime.value, taskRef.value ?? undefined)
    usePlanThreads().add(id)
    text.value = ''
    await router.push(`/plan/${id}`)
    void pending.start(id)
    return true
  }

  return { projectId, project, runtime, runtimeItems, lastRuntime, restoredImages, text, taskRef, busy, start }
}
