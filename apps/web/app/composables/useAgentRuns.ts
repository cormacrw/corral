import type { DesignVersion, Run, RunEvent } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { agentFacts, designerStats } from '~/utils/agents'
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

  const designs = ref<{ taskId: string, versions: DesignVersion[] }[]>([])
  async function loadDesigns() {
    if (agent.value?.role !== 'designer') return
    const agentId = agent.value.id
    const authored = runs.value.filter(r => r.role === 'designer' && r.taskId && r.taskRef)
    const unique = [...new Map(authored.map(r => [r.taskId!, r])).values()]
    const loaded = await Promise.all(unique.map(async (run) => {
      const project = live.state.value.projects.find(p => p.id === run.projectId)
      if (!project) throw new Error('Design project not found')
      return { taskId: run.taskId!, versions: await api.tasks.designs(project.slug, Number(run.taskRef!.split('-').at(-1))) }
    }))
    if (agent.value?.id === agentId) designs.value = loaded
  }
  async function load() {
    if (!agent.value) return
    error.value = null
    try {
      runs.value = await api.runs.list({ agentId: agent.value.id })
      designs.value = []
      await loadDesigns()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }
  watch(agent, () => void load(), { immediate: true })
  watch(selected, async (run, old) => {
    if (!run || run.id === old?.id) return
    try {
      events.value = await api.runs.transcript(run.id)
    } catch {
      events.value = []
    }
    // The live connection appends the run's new events to this same list
    live.watchRun(run.id, events.value)
  }, { immediate: true })
  onMounted(() => {
    const timer = setInterval(() => {
      now.value = Date.now()
    }, 1000)
    const stop = live.subscribe((event) => {
      if (event.type === 'task.updated' && designs.value.some(d => d.taskId === event.task.id)) {
        void loadDesigns().catch((e) => {
          error.value = String(e)
        })
      }
      if (event.type === 'run.updated' && event.run.agentId === agent.value?.id) {
        const i = runs.value.findIndex(r => r.id === event.run.id)
        const previous = runs.value[i]
        if (i >= 0) runs.value.splice(i, 1, event.run)
        else runs.value.unshift(event.run)
        if (!previous || previous.headSha !== event.run.headSha || previous.outcome !== event.run.outcome) {
          void loadDesigns().catch((e) => {
            error.value = String(e)
          })
        }
      }
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
      case 'designer': return [
        { label: 'Runs this week', value: String(thisWeek.value.filter(r => r.role === 'designer').length), sub: `${today.value.length} today` },
        { label: 'Design versions submitted', value: error.value ? '—' : String(designerStats(runs.value, designs.value).submitted), sub: 'recent authoring runs' },
        { label: 'Designs approved', value: error.value ? '—' : String(designerStats(runs.value, designs.value).approved), sub: 'tasks · recent runs' },
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
  const facts = computed(() => agent.value ? agentFacts(agent.value) : '')
  async function stop(run: Run) {
    try {
      await api.runs.stop(run.id)
      toast.add({ title: 'Run stopped', description: 'The task is paused until you resume it.', color: 'neutral' })
    } catch (e) {
      toast.add({ title: 'Could not stop', description: e instanceof Error ? e.message : String(e), color: 'error' })
    }
  }
  // Ends a usage-limit wait early; a real limit just pauses the agent again
  async function resume() {
    if (!agent.value) return
    try {
      await api.agents.patch(agent.value.id, { paused: false })
    } catch (e) {
      toast.add({ title: 'Could not resume', description: e instanceof Error ? e.message : String(e), color: 'error' })
    }
  }
  const project = (run: Run) => live.state.value.projects.find(p => p.id === run.projectId) ?? null
  const projectName = (run: Run) => project(run)?.name ?? ''

  // Mid-run messages (design/agent.md). The runner shows a delivered one as
  // a message event with the text the server sent, so the transcript marks
  // the ones sent from here as yours.
  const runnerOnline = computed(() => !!live.state.value.runner?.online)
  const sent = ref<Record<string, string[]>>({})
  async function message(run: Run, text: string): Promise<boolean> {
    const slug = project(run)?.slug
    if (!slug) return false
    try {
      const { comment } = await api.runs.message(slug, run.id, text)
      ;(sent.value[run.id] ??= []).push(comment.body.trim())
      return true
    } catch (e) {
      toast.add({ title: 'Message not sent', description: e instanceof Error ? e.message : String(e), color: 'error' })
      return false
    }
  }

  return { name, agent, runs, error, events, now, selected, current, load, today, tiles, facts, stop, resume, project, projectName, runnerOnline, sent, message }
}

export type AgentRuns = ReturnType<typeof useAgentRuns>
