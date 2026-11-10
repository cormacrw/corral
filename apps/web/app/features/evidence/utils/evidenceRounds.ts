import type { Evidence } from '@corral/contracts'

// Which evidence is current and which an earlier submission replaced, so every
// view agrees (.corral/wiki/evidence-rounds.md). A submission is a run, not a
// round: changes requested advances the round before the developer attaches
// again, and a resubmission can reuse the round.

interface EarlierRound { round: number, items: Evidence[] }
export interface EvidenceGroupRounds {
  // What the group shows by default: the items of the newest run that
  // attached anything to it
  current: Evidence[]
  // The round those came from when the latest run attached nothing here, so
  // the view can say they're older. Null when they're the latest run's.
  carriedFrom: number | null
  // Everything older, by round, newest first
  earlier: EarlierRound[]
  earlierCount: number
}
type GroupKey = string | null

export interface EvidenceRounds {
  group: (criterionId: GroupKey) => EvidenceGroupRounds
  // Every group's current items, in the order given
  current: Evidence[]
}

export function evidenceRounds(evidence: Evidence[]): EvidenceRounds {
  // Runs ordered by their first evidence; ties keep the order given
  const started = new Map<string, number>()
  for (const e of evidence) {
    const at = Date.parse(e.createdAt)
    const known = started.get(e.runId)
    if (known === undefined || at < known) started.set(e.runId, at)
  }
  const runs = [...started.keys()]
  const order = new Map(runs.map((id, i) => [id, i]))
  runs.sort((a, b) => started.get(a)! - started.get(b)! || order.get(a)! - order.get(b)!)
  const rank = new Map(runs.map((id, i) => [id, i]))
  const latestRun = runs.at(-1) ?? null

  const groups = new Map<GroupKey, EvidenceGroupRounds>()
  const byKey = new Map<GroupKey, Evidence[]>()
  for (const e of evidence) byKey.set(e.criterionId, [...byKey.get(e.criterionId) ?? [], e])
  for (const [key, items] of byKey) {
    const newest = items.reduce((best, e) => rank.get(e.runId)! > rank.get(best)! ? e.runId : best, items[0]!.runId)
    const current = items.filter(e => e.runId === newest)
    const older = items.filter(e => e.runId !== newest).sort((a, b) => rank.get(b.runId)! - rank.get(a.runId)!)
    const rounds = new Map<number, Evidence[]>()
    for (const e of older) rounds.set(e.round, [...rounds.get(e.round) ?? [], e])
    const earlier = [...rounds].map(([round, list]) => ({ round, items: list })).sort((a, b) => b.round - a.round)
    groups.set(key, { current, carriedFrom: newest === latestRun ? null : current[0]!.round, earlier, earlierCount: older.length })
  }

  const empty: EvidenceGroupRounds = { current: [], carriedFrom: null, earlier: [], earlierCount: 0 }
  const currentIds = new Set([...groups.values()].flatMap(g => g.current.map(e => e.id)))
  return {
    group: key => groups.get(key) ?? empty,
    current: evidence.filter(e => currentIds.has(e.id))
  }
}

export const currentEvidence = (evidence: Evidence[]) => evidenceRounds(evidence).current
