import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { DEFAULT_AGENT_RUNTIME, type AgentRuntime } from '@corral/core'
import { useDraft } from '~/composables/useDraft'
import type { PlanStart } from '~/queries/dependencies'
import { usePlanStarts } from '~/queries/plan'
import { clisQuery } from '~/queries/setup'
import { detectedRuntimes, runtimeLabel } from '~/utils/labels'
import { planThreadPath } from '~/utils/routes'

const ATTACHED_IMAGE = /!\[([^\]]*)\]\(attachment:([^)]*)\)/g

// A failed start sent back to the prompt, which takes it up once
export const useRestoredStart = () => useState<PlanStart | null>('restored-plan', () => null)

// A new Plan session before it starts (design/plan.md): the project, runtime,
// draft and attached task, restored when a failed start comes back to the prompt.
export function usePlanStart(initialProjectId: () => string | undefined) {
  const shell = useShell()
  const router = useRouter()
  const pending = usePlanStarts()
  const restoredStart = useRestoredStart()

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
    return found.length > 0 ? found : [DEFAULT_AGENT_RUNTIME]
  })
  const runtimeItems = computed(() => runtimes.value.map(r => ({ label: runtimeLabel(r), value: r })))
  const lastRuntime = useLocalStorage<AgentRuntime>('corral.plan.runtime', DEFAULT_AGENT_RUNTIME)
  const runtime = computed<AgentRuntime>(() => runtimes.value.includes(lastRuntime.value) ? lastRuntime.value : runtimes.value[0]!)

  const restored = restoredStart.value
  restoredStart.value = null
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
    await router.push(planThreadPath(id))
    void pending.start(id)
    return true
  }

  return { projectId, project, runtime, runtimeItems, lastRuntime, restoredImages, text, taskRef, busy, start }
}
