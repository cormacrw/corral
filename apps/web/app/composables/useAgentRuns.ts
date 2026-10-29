import type { Run, RunEvent } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { isLiveRun, tokens } from '~/utils/labels'

// An agent's page (design/agent.md): the agent from the route, its runs,
// the selected run's transcript (streamed while live) and its stats. The
// web page and the mobile screens share it. `autoSelect` picks the current
// or latest run when the URL names none, as the web page's transcript pane
// does; mobile only shows a transcript for a run in the URL.
export function useAgentRuns(options: { autoSelect: () => boolean }) {
  const route = useRoute()
  const live = useLive()
  const toast = useToast()
  const name = computed(() => String(route.params.name))
  const agent = computed(() => live.state.value.agents.find(a => a.name.toLowerCase() === name.value.toLowerCase()) ?? null)
  const runs = ref<Run[]>([])
  const error = ref<string | null>(null)
  const events = ref<RunEvent[]>([])
  const now = ref(Date.now())

  const selectedId = computed(() => typeof route.params.runId === 'string' ? route.params.runId : null)
  const current = computed(() => runs.value.find(isLiveRun) ?? null)
  const selected = computed(() => {
    const named = runs.value.find(r => r.id === selectedId.value)
    if (named || !options.autoSelect()) return named ?? null
    return current.value ?? runs.value[0] ?? null
  })

  async function load() {
    if (!agent.value) return
    error.value = null
    try {
      runs.value = await api.runs.list({ agentId: agent.value.id })
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }
  watch(agent, () => void load(), { immediate: true })
  watch(selected, async (run, old) => {
    if (!run || run.id === old?.id) return
    try {
      events.value = await api.runs.transcript(run.id)
      live.watchRun(run.id, events.value)
    } catch {
      events.value = []
    }
  }, { immediate: true })
  onMounted(() => {
    const timer = setInterval(() => {
      now.value = Date.now()
    }, 1000)
    const stop = live.subscribe((event) => {
      if (event.type === 'run.updated' && event.run.agentId === agent.value?.id) {
        const i = runs.value.findIndex(r => r.id === event.run.id)
        if (i >= 0) runs.value.splice(i, 1, event.run)
        else runs.value.unshift(event.run)
      }
      if (event.type === 'run.events' && event.runId === selected.value?.id) events.value.push(...event.events)
    })
    onBeforeUnmount(() => {
      clearInterval(timer)
      stop()
    })
  })

  const weekAgo = computed(() => now.value - 7 * 86_400_000)
  const thisWeek = computed(() => runs.value.filter(r => new Date(r.queuedAt).getTime() > weekAgo.value))
  const avgRun = computed(() => {
    const done = thisWeek.value.filter(r => r.startedAt && r.endedAt)
    if (done.length === 0) return '—'
    const ms = done.reduce((n, r) => n + new Date(r.endedAt!).getTime() - new Date(r.startedAt!).getTime(), 0) / done.length
    return `${Math.round(ms / 60_000)}m`
  })
  const today = computed(() => runs.value.filter(r => new Date(r.queuedAt).toDateString() === new Date(now.value).toDateString()))
  const usageToday = computed(() => tokens(today.value.reduce((n, r) => n + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0)))
  const tiles = computed(() => {
    if (!agent.value) return []
    const count = (outcome: string) => thisWeek.value.filter(r => r.outcome === outcome).length
    switch (agent.value.role) {
      case 'developer': return [
        { label: 'Runs this week', value: String(thisWeek.value.length), sub: `${today.value.length} today` },
        { label: 'PRs opened', value: String(count('pr_opened') + count('pr_updated')), sub: 'incl. revisions' },
        { label: 'Stuck', value: String(count('stuck')), sub: 'asked you' },
        { label: 'Avg run', value: avgRun.value, sub: 'this week' },
        { label: 'Usage today', value: usageToday.value, sub: 'tokens' }
      ]
      case 'reviewer': return [
        { label: 'Reviews this week', value: String(thisWeek.value.length), sub: `${today.value.length} today` },
        { label: 'Approved', value: String(count('approved')), sub: '' },
        { label: 'Changes requested', value: String(count('changes_requested')), sub: '' },
        { label: 'Avg review', value: avgRun.value, sub: 'this week' },
        { label: 'Usage today', value: usageToday.value, sub: 'tokens' }
      ]
      default: return [
        { label: 'Turns this week', value: String(thisWeek.value.length), sub: `${today.value.length} today` },
        { label: 'Avg turn', value: avgRun.value, sub: 'this week' },
        { label: 'Usage today', value: usageToday.value, sub: 'tokens' }
      ]
    }
  })
  const facts = computed(() => {
    if (!agent.value) return ''
    const where = agent.value.role === 'developer' ? 'one worktree per task' : agent.value.role === 'reviewer' ? 'a read-only task worktree' : 'a read-only checkout of the default branch'
    // The PM has no concurrency, only one turn per Plan session (D13)
    const limit = agent.value.role === 'pm' ? 'One turn per session' : `Concurrency ${agent.value.concurrency}`
    return `${limit} · ${where} · .corral/agents/${agent.value.role}.md`
  })
  async function stop(run: Run) {
    try {
      await api.runs.stop(run.id)
      toast.add({ title: 'Run stopped', description: 'The task is paused until you resume it.', color: 'neutral' })
    } catch (e) {
      toast.add({ title: 'Could not stop', description: e instanceof Error ? e.message : String(e), color: 'error' })
    }
  }
  const project = (run: Run) => live.state.value.projects.find(p => p.id === run.projectId) ?? null
  const projectName = (run: Run) => project(run)?.name ?? ''

  return { name, agent, runs, error, events, now, selected, current, load, today, tiles, facts, stop, project, projectName }
}

export type AgentRuns = ReturnType<typeof useAgentRuns>
