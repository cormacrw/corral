import type { RunEvent } from '@corral/contracts'

// Turns a run's events into the transcript's entries (design/agent.md):
// consecutive tool calls collapse into one group of plain-English steps

type Kind = 'read' | 'edit' | 'command' | 'search' | 'fetch' | 'phrase' | 'other'

// The CLI's own bookkeeping, not work the agent did
const HIDDEN_TOOLS = new Set(['ToolSearch'])

export interface ToolStep {
  key: number
  kind: Kind
  verb: string
  target: string
  // File the step touched, so a group counts each file once
  file?: string
  added?: number
  removed?: number
  input: unknown
  output?: string
  isError: boolean
  done: boolean
}

export type TranscriptEntry
  = | { key: number, type: 'system', text: string }
    | { key: number, type: 'message', text: string }
    | { key: number, type: 'thinking', text: string }
    | { key: number, type: 'steps', steps: ToolStep[], revision: number }

type StepsEntry = Extract<TranscriptEntry, { type: 'steps' }>

// Builds entries as a transcript grows, looking only at the lines it hasn't
// seen. Entries change in place, and a group's `revision` says when. A list
// that isn't the last one plus more lines starts over.
export function transcriptFold(): (events: RunEvent[]) => TranscriptEntry[] {
  let list: TranscriptEntry[] = []
  let byId = new Map<string, { step: ToolStep, group: StepsEntry }>()
  let seen: RunEvent[] = []
  return (events) => {
    const last = seen.length - 1
    if (events.length < seen.length || events[0] !== seen[0] || events[last] !== seen[last]) {
      list = []
      byId = new Map()
      seen = []
    }
    for (let i = seen.length; i < events.length; i++) addEvent(list, byId, events[i]!, i)
    seen = events
    return list
  }
}

export const transcriptEntries = (events: RunEvent[]): TranscriptEntry[] => transcriptFold()(events)

function addEvent(list: TranscriptEntry[], byId: Map<string, { step: ToolStep, group: StepsEntry }>, event: RunEvent, i: number): void {
  switch (event.type) {
    case 'system':
      list.push({ key: i, type: 'system', text: event.text })
      break
    case 'message':
      list.push({ key: i, type: 'message', text: event.text })
      break
    case 'thinking': {
      // The CLI marks an empty thinking block at the start of most turns.
      // One between tool calls doesn't split their group, and consecutive
      // empty ones show as one "Thinking" step. Thinking with text does
      // split the group, as its own step.
      const last = list.at(-1)
      const text = event.text.trim()
      if (!text && (last?.type === 'steps' || (last?.type === 'thinking' && !last.text))) break
      list.push({ key: i, type: 'thinking', text })
      break
    }
    case 'tool_call': {
      if (HIDDEN_TOOLS.has(event.tool)) break
      const step: ToolStep = { key: i, ...describe(event.tool, event.input), input: event.input, isError: false, done: false }
      const last = list.at(-1)
      const group: StepsEntry = last?.type === 'steps' ? last : { key: i, type: 'steps', steps: [], revision: 0 }
      if (group !== last) list.push(group)
      group.steps.push(step)
      group.revision++
      byId.set(event.id, { step, group })
      break
    }
    case 'tool_result': {
      const found = byId.get(event.id)
      if (found) {
        found.step.output = event.output
        found.step.isError = event.isError
        found.step.done = true
        found.group.revision++
      }
      break
    }
    default:
      break
  }
}

// "Read 2 files, ran a command, attached evidence"
export function summarizeSteps(steps: ToolStep[]): string {
  const parts = new Map<string, string>()
  const files = (kind: Kind) => new Set(steps.filter(s => s.kind === kind).map(s => s.file ?? s.target)).size
  const count = (kind: Kind) => steps.filter(s => s.kind === kind).length
  for (const step of steps) {
    const id = step.kind === 'phrase' ? `phrase:${step.verb}` : step.kind
    if (parts.has(id)) continue
    switch (step.kind) {
      case 'read':
        parts.set(id, `read ${plural(files('read'), 'file')}`)
        break
      case 'edit':
        parts.set(id, `edited ${plural(files('edit'), 'file')}`)
        break
      case 'command':
        parts.set(id, count('command') === 1 ? 'ran a command' : `ran ${count('command')} commands`)
        break
      case 'search':
        parts.set(id, count('search') === 1 ? 'searched once' : `searched ${count('search')} times`)
        break
      case 'fetch':
        parts.set(id, count('fetch') === 1 ? 'fetched a page' : `fetched ${count('fetch')} pages`)
        break
      case 'phrase':
        parts.set(id, lowerFirst(step.verb))
        break
      default:
        parts.set(id, count('other') === 1 ? 'used a tool' : `used ${count('other')} tools`)
    }
  }
  const text = [...parts.values()].join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function describe(rawTool: string, input: unknown): Pick<ToolStep, 'kind' | 'verb' | 'target' | 'file' | 'added' | 'removed'> {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (key: string) => (typeof o[key] === 'string' ? o[key] : '')
  const tool = rawTool.replace(/^mcp__corral__/, '')
  switch (tool) {
    case 'Read':
      return { kind: 'read', verb: 'Read', target: relative(str('file_path')), file: str('file_path') }
    case 'Edit':
      return { kind: 'edit', verb: 'Edited', target: relative(str('file_path')), file: str('file_path'), added: lines(str('new_string')), removed: lines(str('old_string')) }
    case 'MultiEdit': {
      const edits = (Array.isArray(o.edits) ? o.edits : []) as Record<string, unknown>[]
      const sum = (key: string) => edits.reduce((n, e) => n + lines(typeof e[key] === 'string' ? e[key] : ''), 0)
      return { kind: 'edit', verb: 'Edited', target: relative(str('file_path')), file: str('file_path'), added: sum('new_string'), removed: sum('old_string') }
    }
    case 'Write':
      return { kind: 'edit', verb: 'Wrote', target: relative(str('file_path')), file: str('file_path'), added: lines(str('content')), removed: 0 }
    case 'NotebookEdit':
      return { kind: 'edit', verb: 'Edited', target: relative(str('notebook_path')), file: str('notebook_path') }
    case 'Bash':
      return { kind: 'command', verb: 'Ran', target: str('command').split('\n')[0] ?? '' }
    case 'Grep':
    case 'Glob':
      return { kind: 'search', verb: 'Searched', target: str('pattern') }
    case 'WebSearch':
      return { kind: 'search', verb: 'Searched the web', target: str('query') }
    case 'WebFetch':
      return { kind: 'fetch', verb: 'Fetched', target: str('url') }
    case 'TodoWrite':
      return { kind: 'phrase', verb: 'Updated its to-do list', target: '' }
    case 'Task':
    case 'Agent':
      return { kind: 'phrase', verb: 'Delegated to a subagent', target: str('description') }
    case 'get_task':
      return { kind: 'phrase', verb: 'Looked up the task', target: '' }
    case 'add_comment':
      return { kind: 'phrase', verb: 'Left a comment', target: firstLine(str('body')) }
    case 'attach_evidence':
      return { kind: 'phrase', verb: 'Attached evidence', target: str('note') || relative(str('path')) }
    case 'get_evidence':
      return { kind: 'phrase', verb: 'Checked the evidence', target: str('evidenceId') }
    case 'get_attachment':
      return { kind: 'phrase', verb: 'Looked at an attachment', target: str('attachmentId') }
    case 'get_design':
      return { kind: 'phrase', verb: 'Read the design', target: [str('taskRef'), typeof o.version === 'number' ? `v${o.version}` : ''].filter(Boolean).join(' ') }
    case 'report_outcome':
      return { kind: 'phrase', verb: 'Reported the outcome', target: str('outcome') }
    case 'list_tasks':
      return { kind: 'phrase', verb: 'Listed the tasks', target: '' }
    case 'get_run_outcomes':
      return { kind: 'phrase', verb: 'Checked past runs', target: str('taskRef') }
    case 'get_agent_activity':
      return { kind: 'phrase', verb: 'Checked what the team is doing', target: str('agent') }
    case 'list_runs':
      return { kind: 'phrase', verb: 'Listed runs', target: [str('role'), str('status')].filter(Boolean).join(' ') }
    case 'get_run':
      return { kind: 'phrase', verb: 'Read a run', target: typeof o.runNumber === 'number' ? `#${o.runNumber}` : str('runId') }
    case 'ask_question':
      return { kind: 'phrase', verb: 'Asked a question', target: firstLine(str('question')) }
    case 'propose_plan':
      return { kind: 'phrase', verb: 'Proposed a plan', target: str('title') }
    case 'approve_plan':
      return { kind: 'phrase', verb: 'Approved the plan', target: str('to') }
    case 'flag_stale_docs':
      return { kind: 'phrase', verb: 'Flagged stale docs', target: str('title') }
    default:
      return { kind: 'other', verb: tool.replace(/^mcp__[^_]+__/, ''), target: firstLine(str('file_path') || str('path') || str('query') || str('url')) }
  }
}

// Paths inside a run's worktree (<data>/worktrees/<id>/…) read from the repo
// root, and ones in its scratch folder (<data>/scratch/<id>/…) from scratch/
function relative(path: string): string {
  return path.replace(/^.*\/worktrees\/[^/]+\//, '').replace(/^.*\/scratch\/[^/]+\//, 'scratch/')
}

function lines(text: string): number {
  return text ? text.split('\n').length : 0
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

// How many tool steps a transcript shows, for a turn's "N steps" disclosure
export function countSteps(events: RunEvent[]): number {
  return transcriptEntries(events).reduce((n, entry) => n + (entry.type === 'steps' ? entry.steps.length : 0), 0)
}

// A transcript without the messages already shown on their own, such as the
// PM's reply in Plan, so they don't appear twice
export function withoutMessages(events: RunEvent[], texts: string[]): RunEvent[] {
  const shown = new Set(texts.map(t => t.trim()))
  return events.filter(e => e.type !== 'message' || !shown.has(e.text.trim()))
}
