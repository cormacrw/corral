import type { PullRequestDetail, PullRequestGuide, Task } from '@corral/contracts'

// Guided code review (COR-518, design): the guide's steps resolved against the
// PR's diff. A hunk is one `@@` block of a file's patch. Hunks the model left
// out go to a last "Other changes" step, so every hunk is in exactly one step.
export interface GuideHunk {
  path: string
  index: number
  // Null when the file is past the diff's cap and only on GitHub
  lines: string[] | null
}
export interface GuideStep {
  id: string
  title: string
  why: string
  criteria: string[]
  hunks: GuideHunk[]
  other: boolean
}

export function splitHunks(patch: string): string[][] {
  const hunks: string[][] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || hunks.length === 0) hunks.push([])
    hunks.at(-1)!.push(line)
  }
  return patch ? hunks : []
}

export function guideSteps(pr: PullRequestDetail, guide: PullRequestGuide, criteria: Task['acceptanceCriteria']): GuideStep[] {
  const byPath = new Map(pr.files.map(f => [f.path, splitHunks(f.patch)]))
  const used = new Set<string>()
  const steps: GuideStep[] = guide.steps.map(s => ({
    id: s.id,
    title: s.title,
    why: s.why,
    criteria: s.criterionIds.map(id => criteria.find(c => c.id === id)?.text).filter((t): t is string => !!t),
    other: false,
    hunks: s.hunks.map((h) => {
      used.add(`${h.path}#${h.hunk}`)
      return { path: h.path, index: h.hunk, lines: byPath.get(h.path)?.[h.hunk] ?? null }
    })
  }))
  const rest = pr.files.flatMap(f => (byPath.get(f.path) ?? []).map((lines, index) => ({ path: f.path, index, lines })))
    .filter(h => !used.has(`${h.path}#${h.index}`))
  if (rest.length) {
    steps.push({
      id: 'other', title: 'Other changes', other: true, criteria: [], hunks: rest,
      why: 'Hunks the guide didn\'t place in a step, such as imports, docs and small tidy-ups. Read them before you approve.'
    })
  }
  return steps
}

export const diffLineClass = (line: string) => line.startsWith('@@')
  ? 'bg-muted text-muted-foreground'
  : line.startsWith('+') ? 'bg-success/10 text-foreground' : line.startsWith('-') ? 'bg-destructive/10 text-foreground' : 'text-muted-foreground'

// Scrolls the panel's own scroller, never the page, to put `el` under the
// sticky Guided · Files switch
export function scrollInPanel(el: Element | null | undefined, offset = 52) {
  const scroller = el?.closest<HTMLElement>('[data-testid="inbox-detail-scroller"]')
  if (!el || !scroller) return
  scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset })
}
