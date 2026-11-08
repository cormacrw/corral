import { taskNumber, agentStatus, tokens, waitingOnUsageLimit } from '~/utils/labels'
import { errorMessage } from '~/lib/errors'
import { useMutation, useQueries, useQuery } from '@tanstack/vue-query'
import { isActiveRun } from '@corral/core'
import type { Run } from '@corral/contracts'
import { patchAgent } from '~/queries/agents'
import { messageRun, runsQuery, runTranscriptQuery, stopRun } from '~/queries/runs'
import { useShell } from '~/queries/shell'
import { taskDesignsQuery } from '~/queries/tasks'
import { agentFacts, designerStats, usedTokens } from '~/features/agents/utils/agents'
import { sameDay } from '~/utils/days'

// An agent's page (design/agent.md): the agent from the route, its runs,
// the selected run's transcript (streamed while live) and its stats. The
// web page and the mobile screens share it. Only a run named in the URL is
// selected: with none, the web page shows the agent's dashboard.
export function useAgentRuns() {
  const route = useRoute()
  const toast = useToast()
  const name = computed(() => String(route.params.name))
  const shell = useShell()
  const projects = computed(() => shell.projects)
  const agent = computed(() => shell.agents.find(a => a.name.toLowerCase() === name.value.toLowerCase()) ?? null)
  const missing = computed(() => shell.loaded && !agent.value)
  const now = ref(Date.now())
  const status = computed(() => agent.value ? agentStatus(agent.value, now.value) : null)
  // Resume now only makes sense while waiting out a usage limit
  const limited = computed(() => !!agent.value && waitingOnUsageLimit(agent.value, now.value))

  const list = useQuery(computed(() => ({ ...runsQuery({ agentId: agent.value?.id }), enabled: !!agent.value })))
  const runs = computed(() => list.data.value ?? [])
  const pending = list.isPending
  // The runs themselves failed, as opposed to a designer's design data
  const runsFailed = computed(() => !!list.error.value)

  const selectedId = computed(() => typeof route.params.runId === 'string' ? route.params.runId : null)
  const current = computed(() => runs.value.find(r => isActiveRun(r.state)) ?? null)
  const selected = computed(() => runs.value.find(r => r.id === selectedId.value) ?? null)
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
    return slug ? [{ taskId: run.taskId!, slug, ref: run.taskRef!, number: taskNumber(run.taskRef!) }] : []
  }))
  const designQueries = useQueries({ queries: computed(() => designTasks.value.map(task => taskDesignsQuery(task))), shallow: true })
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

  // The tiles count by day and week, so they needn't follow every second
  const minute = computed(() => Math.floor(now.value / 60_000) * 60_000)
  const weekAgo = computed(() => minute.value - 7 * 86_400_000)
  const thisWeek = computed(() => runs.value.filter(r => new Date(r.queuedAt).getTime() > weekAgo.value))
  const avgRun = computed(() => {
    const done = thisWeek.value.filter(r => r.startedAt && r.endedAt)
    if (done.length === 0) return '—'
    const ms = done.reduce((n, r) => n + new Date(r.endedAt!).getTime() - new Date(r.startedAt!).getTime(), 0) / done.length
    return `${Math.round(ms / 60_000)}m`
  })
  const today = computed(() => runs.value.filter(r => sameDay(r.queuedAt, minute.value)))
  const usageToday = computed(() => tokens(today.value.reduce((n, r) => n + usedTokens(r), 0)))
  // Without the runs every count is unknown: a dash and the reason, never a zero
  const tiles = computed(() => list.error.value
    ? roleTiles.value.map(tile => ({ ...tile, value: '—', sub: 'Couldn\'t load runs' }))
    : roleTiles.value)
  const roleTiles = computed(() => {
    if (!agent.value) return []
    const count = (outcome: string) => thisWeek.value.filter(r => r.outcome === outcome).length
    switch (agent.value.role) {
      case 'developer': return [
        { label: 'Runs this week', value: String(thisWeek.value.length), sub: `${today.value.length} today`, icon: 'i-hugeicons-play' },
        { label: 'PRs opened', value: String(count('pr_opened') + count('pr_updated') + count('commit_submitted')), sub: 'incl. revisions and commits', icon: 'i-hugeicons-git-pull-request' },
        { label: 'Stuck', value: String(count('stuck')), sub: 'asked you', icon: 'i-hugeicons-alert-02' },
        { label: 'Avg run', value: avgRun.value, sub: 'this week', icon: 'i-hugeicons-clock-01', avg: true },
        { label: 'Usage today', value: usageToday.value, sub: 'tokens', icon: 'i-hugeicons-coins-01' }
      ]
      case 'designer': return [
        { label: 'Runs this week', value: String(thisWeek.value.filter(r => r.role === 'designer').length), sub: `${today.value.length} today`, icon: 'i-hugeicons-play' },
        { label: 'Design versions submitted', value: error.value ? '—' : String(designerStats(runs.value, designs.value).submitted), sub: 'recent authoring runs', icon: 'i-hugeicons-task-01' },
        { label: 'Designs approved', value: error.value ? '—' : String(designerStats(runs.value, designs.value).approved), sub: 'tasks · recent runs', icon: 'i-hugeicons-checkmark-circle-02' },
        { label: 'Avg run', value: avgRun.value, sub: 'this week', icon: 'i-hugeicons-clock-01', avg: true },
        { label: 'Usage today', value: usageToday.value, sub: 'tokens', icon: 'i-hugeicons-coins-01' }
      ]
      case 'reviewer': return [
        { label: 'Reviews this week', value: String(thisWeek.value.length), sub: `${today.value.length} today`, icon: 'i-hugeicons-play' },
        { label: 'Approved', value: String(count('approved')), sub: '', icon: 'i-hugeicons-checkmark-circle-02' },
        { label: 'Changes requested', value: String(count('changes_requested')), sub: '', icon: 'i-hugeicons-pencil-edit-02' },
        { label: 'Avg review', value: avgRun.value, sub: 'this week', icon: 'i-hugeicons-clock-01', avg: true },
        { label: 'Usage today', value: usageToday.value, sub: 'tokens', icon: 'i-hugeicons-coins-01' }
      ]
      default: return [
        { label: 'Turns this week', value: String(thisWeek.value.length), sub: `${today.value.length} today`, icon: 'i-hugeicons-play' },
        { label: 'Avg turn', value: avgRun.value, sub: 'this week', icon: 'i-hugeicons-clock-01', avg: true },
        { label: 'Usage today', value: usageToday.value, sub: 'tokens', icon: 'i-hugeicons-coins-01' }
      ]
    }
  })
  const facts = computed(() => agent.value ? agentFacts(agent.value) : '')
  const stopping = useMutation(stopRun)
  async function stop(run: Run) {
    if (stopping.isPending.value) return
    try {
      await stopping.mutateAsync(run.id)
      toast.add({ title: 'Run stopped', description: 'The task is paused until you resume it.', color: 'neutral' })
    } catch (e) {
      toast.add({ title: 'Could not stop', description: errorMessage(e), color: 'error' })
    }
  }
  // Ends a usage-limit wait early; a real limit just pauses the agent again
  const patch = useMutation(patchAgent)
  async function resume() {
    if (!agent.value) return
    try {
      await patch.mutateAsync({ id: agent.value.id, input: { paused: false } })
    } catch (e) {
      toast.add({ title: 'Could not resume', description: errorMessage(e), color: 'error' })
    }
  }
  const project = (run: Run) => projects.value.find(p => p.id === run.projectId) ?? null
  const projectName = (run: Run) => project(run)?.name ?? ''

  // Mid-run messages (design/agent.md). The runner shows a delivered one as
  // a message event with the text the server sent, so the transcript marks
  // the ones sent from here as yours.
  const runnerOnline = computed(() => !!shell.runner?.online)
  const sent = ref<Record<string, string[]>>({})
  async function message(run: Run, text: string): Promise<boolean> {
    const slug = project(run)?.slug
    if (!slug) return false
    try {
      const { comment } = await messageRun({ slug, id: run.id, text })
      ;(sent.value[run.id] ??= []).push(comment.body.trim())
      return true
    } catch (e) {
      toast.add({ title: 'Message not sent', description: errorMessage(e), color: 'error' })
      return false
    }
  }

  return { name, agent, status, limited, missing, runs, pending, error, runsFailed, events, now, selected, current, load, today, tiles, facts, stop, stopping: stopping.isPending, resume, project, projectName, runnerOnline, sent, message }
}

export type AgentRuns = ReturnType<typeof useAgentRuns>
