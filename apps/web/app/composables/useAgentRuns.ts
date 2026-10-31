import { useMutation, useQueries, useQuery } from '@tanstack/vue-query'
import type { Run } from '@corral/contracts'
import { patchAgent } from '~/queries/agents'
import { messageRun, runsQuery, runTranscriptQuery, stopRun } from '~/queries/runs'
import { shell } from '~/queries/shell'
import { taskDesignsQuery } from '~/queries/tasks'
import { agentFacts, designerStats } from '~/utils/agents'
import { isLiveRun, tokens } from '~/utils/labels'

// An agent's page (design/agent.md): the agent from the route, its runs,
// the selected run's transcript (streamed while live) and its stats. The
// web page and the mobile screens share it. `autoSelect` picks the current
// or latest run when the URL names none, as the web page's transcript pane
// does; mobile only shows a transcript for a run in the URL.
export function useAgentRuns(options: { autoSelect: () => boolean }) {
  const route = useRoute()
  const toast = useToast()
  const name = computed(() => String(route.params.name))
  const projects = computed(() => shell()?.projects.data.value ?? [])
  const agent = computed(() => shell()?.agents.data.value?.find(a => a.name.toLowerCase() === name.value.toLowerCase()) ?? null)
  const now = ref(Date.now())

  const list = useQuery(computed(() => ({ ...runsQuery({ agentId: agent.value?.id }), enabled: !!agent.value })))
  const runs = computed(() => list.data.value ?? [])
  const pending = list.isPending

  const selectedId = computed(() => typeof route.params.runId === 'string' ? route.params.runId : null)
  const current = computed(() => runs.value.find(isLiveRun) ?? null)
  const selected = computed(() => {
    const named = runs.value.find(r => r.id === selectedId.value)
    if (named || !options.autoSelect()) return named ?? null
    return current.value ?? runs.value[0] ?? null
  })
  // Live events append to this same query
  const transcript = useQuery(computed(() => ({ ...runTranscriptQuery(selected.value?.id ?? ''), enabled: !!selected.value })))
  const events = computed(() => transcript.data.value ?? [])

  // One entry per task a designer authored
  const authored = computed(() => {
    if (agent.value?.role !== 'designer') return []
    const designed = runs.value.filter(r => r.role === 'designer' && r.taskId && r.taskRef)
    return [...new Map(designed.map(r => [r.taskId!, r])).values()]
  })
  const designTasks = computed(() => authored.value.flatMap((run) => {
    const slug = projects.value.find(p => p.id === run.projectId)?.slug
    return slug ? [{ taskId: run.taskId!, slug, ref: run.taskRef!, number: Number(run.taskRef!.split('-').at(-1)) }] : []
  }))
  const designQueries = useQueries({ queries: computed(() => designTasks.value.map(task => taskDesignsQuery(task))) })
  const designs = computed(() => designTasks.value.flatMap(({ taskId }, i) => {
    const versions = designQueries.value[i]?.data
    return versions ? [{ taskId, versions }] : []
  }))
  const error = computed(() => {
    const failed = list.error.value ?? designQueries.value.find(query => query.error)?.error
    if (failed) return failed.message
    return designTasks.value.length < authored.value.length && projects.value.length ? 'Design project not found' : null
  })
  async function load() {
    await Promise.all([list.refetch(), ...designQueries.value.map(query => query.refetch())])
  }

  onMounted(() => {
    const timer = setInterval(() => {
      now.value = Date.now()
    }, 1000)
    onBeforeUnmount(() => clearInterval(timer))
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
        { label: 'PRs opened', value: String(count('pr_opened') + count('pr_updated') + count('commit_submitted')), sub: 'incl. revisions and commits' },
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
  const stopping = useMutation(stopRun)
  async function stop(run: Run) {
    try {
      await stopping.mutateAsync(run.id)
      toast.add({ title: 'Run stopped', description: 'The task is paused until you resume it.', color: 'neutral' })
    } catch (e) {
      toast.add({ title: 'Could not stop', description: e instanceof Error ? e.message : String(e), color: 'error' })
    }
  }
  // Ends a usage-limit wait early; a real limit just pauses the agent again
  const patch = useMutation(patchAgent)
  async function resume() {
    if (!agent.value) return
    try {
      await patch.mutateAsync({ id: agent.value.id, input: { paused: false } })
    } catch (e) {
      toast.add({ title: 'Could not resume', description: e instanceof Error ? e.message : String(e), color: 'error' })
    }
  }
  const project = (run: Run) => projects.value.find(p => p.id === run.projectId) ?? null
  const projectName = (run: Run) => project(run)?.name ?? ''

  // Mid-run messages (design/agent.md). The runner shows a delivered one as
  // a message event with the text the server sent, so the transcript marks
  // the ones sent from here as yours.
  const runnerOnline = computed(() => !!shell()?.runner.data.value?.online)
  const sent = ref<Record<string, string[]>>({})
  async function message(run: Run, text: string): Promise<boolean> {
    const slug = project(run)?.slug
    if (!slug) return false
    try {
      const { comment } = await messageRun({ slug, id: run.id, text })
      ;(sent.value[run.id] ??= []).push(comment.body.trim())
      return true
    } catch (e) {
      toast.add({ title: 'Message not sent', description: e instanceof Error ? e.message : String(e), color: 'error' })
      return false
    }
  }

  return { name, agent, runs, pending, error, events, now, selected, current, load, today, tiles, facts, stop, resume, project, projectName, runnerOnline, sent, message }
}

export type AgentRuns = ReturnType<typeof useAgentRuns>
