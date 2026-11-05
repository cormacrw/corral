import type { PullRequestDetail, PullRequestGuide, Task } from '@corral/contracts'
import { splitPatchHunks } from '@corral/contracts/client'

// Guided code review (COR-525, .corral/wiki/pr-guides.md): the guide's steps
// resolved against the PR's capped diff. A hunk is one `@@` block of a file's
// patch. Hunks no step covers go to a last "Other changes" step, so every hunk
// of the shown diff is in exactly one step.
export interface GuideHunk {
  path: string
  index: number
  // Null when the hunk is past the diff's cap and only on GitHub
  lines: string[] | null
  // The line cap cut this hunk partway: only its first lines are here
  partial: boolean
}
export interface GuideStep {
  id: string
  title: string
  why: string
  criteria: string[]
  hunks: GuideHunk[]
  other: boolean
}

export const OTHER_CHANGES_WHY = 'Hunks the guide didn\'t place in a step, such as imports, docs and small tidy-ups. Read them before you approve.'

export function hunkCount(pr: PullRequestDetail): number {
  return pr.files.reduce((n, f) => n + splitPatchHunks(f.patch).length, 0)
}

// Whether the line cap cut this file's patch partway (the server keeps the
// start of the file that goes over it), so its last hunk is incomplete
export function patchCut(file: PullRequestDetail['files'][number]): boolean {
  if (!file.patch) return false
  const changed = file.patch.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length
  return changed < file.additions + file.deletions
}

export function guideSteps(pr: PullRequestDetail, guide: PullRequestGuide, criteria: Pick<Task['acceptanceCriteria'][number], 'id' | 'text'>[]): GuideStep[] {
  const byPath = new Map(pr.files.map(f => [f.path, splitPatchHunks(f.patch)]))
  const cut = new Set(pr.truncated ? pr.files.filter(patchCut).map(f => f.path) : [])
  const resolve = (path: string, index: number): GuideHunk => {
    const lines = byPath.get(path)?.[index] ?? null
    return { path, index, lines, partial: !!lines && cut.has(path) && index === byPath.get(path)!.length - 1 }
  }
  const used = new Set<string>()
  const steps: GuideStep[] = guide.steps.map(s => ({
    id: s.id,
    title: s.title,
    why: s.why,
    criteria: s.criterionIds.map(id => criteria.find(c => c.id === id)?.text).filter((t): t is string => !!t),
    other: false,
    hunks: s.hunks.filter((h) => {
      const key = `${h.path}#${h.hunk}`
      if (used.has(key)) return false
      used.add(key)
      return true
    }).map(h => resolve(h.path, h.hunk))
  })).filter(s => s.hunks.length)
  const rest = pr.files.flatMap(f => byPath.get(f.path)!.map((_, index) => resolve(f.path, index)))
    .filter(h => !used.has(`${h.path}#${h.index}`))
  if (rest.length) steps.push({ id: 'other', title: 'Other changes', other: true, criteria: [], hunks: rest, why: OTHER_CHANGES_WHY })
  return steps
}

export const diffLineClass = (line: string) => line.startsWith('@@')
  ? 'bg-muted text-muted-foreground'
  : line.startsWith('+') ? 'bg-success/10 text-foreground' : line.startsWith('-') ? 'bg-destructive/10 text-foreground' : 'text-muted-foreground'

// Scrolls the panel's own scroller, never the page, to put `el` just under
// whatever sticks at the top of it (the Guided · Files switch)
export function scrollInPanel(el: Element | null | undefined) {
  const scroller = el?.closest<HTMLElement>('[data-testid="inbox-detail-scroller"]')
  if (!el || !scroller) return
  const top = scroller.getBoundingClientRect().top
  // Where the stuck switch ends: its height less how far above the top it sticks
  const bar = scroller.querySelector<HTMLElement>('[data-guide-switch]')
  const offset = bar ? Math.max(0, bar.offsetHeight + (Number.parseFloat(getComputedStyle(bar).top) || 0)) : 0
  scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - top - offset })
}
