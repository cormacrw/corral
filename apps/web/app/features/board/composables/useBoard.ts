import { useQuery } from '@tanstack/vue-query'
import { BOARD_COLUMNS, columnEntries, epicOnBoard, epicStage, epicWorkingAgents, isTopLevel, matchesEpicFilter, matchesFilter, matchesParentFilter, onBoard, parentColumn, taskAgentIds, unfinishedPrerequisites } from '~/features/board/utils/board'
import { runsQuery } from '~/queries/runs'
import { epicTitle, epicWithLiveCounts, STATUS, STATUS_DOT } from '~/utils/labels'

// The Board's data (design/board.md), shared by BoardDesktop and BoardMobile
// so both layouts filter the same way
export function useBoard() {
  const shell = useShell()
  const { slug, tasks: all, parents, epics: epicList, loading, error, refetch } = useProject()
  const { filters, view, search } = useBoardRouteState()

  const epics = computed(() => [...new Set(all.value.map(t => t.epicId).filter((id): id is string => Boolean(id)))])
  const epicLabel = (id: string) => epicTitle(epicList.value, id, epics.value.indexOf(id))
  const epicOptions = computed(() => epics.value.map(id => ({ id, label: epicLabel(id) })))
  // Agents that work on tasks, for the Agent filter
  const taskAgents = computed(() => shell.agents.filter(a => a.role !== 'pm'))
  const visible = computed(() => all.value.filter(t => onBoard(t) && matchesFilter(t, filters.value, taskAgentIds(t)) && (view.value === 'all' || isTopLevel(t))))
  // Epic details opens the epic only when exactly one is selected
  const single = computed(() => filters.value.epics.length === 1 ? filters.value.epics[0]! : null)

  // Parents with work left or sub-tasks on the Board, so one waiting on its PR
  // stays here after its sub-tasks leave the Complete column. A collapsed
  // one-task epic has no parent: its task is on the Board itself.
  const liveEpics = computed(() => epicList.value.map(epic => epicWithLiveCounts(epic, all.value)))
  const onBoardEpics = computed(() => liveEpics.value.filter(epic => (epic.taskId || epic.branch) && epicOnBoard(epic, all.value.filter(t => t.epicId === epic.id))))
  // One card per parent, in the column its stage names, in the top-level view
  const emptyParents = computed(() => liveEpics.value.filter(epic => parents.value.some(p => p.id === epic.taskId && p.rollup?.total === 0)))
  const visibleEpics = computed(() => view.value === 'top' ? [...onBoardEpics.value, ...emptyParents.value.filter(e => !onBoardEpics.value.includes(e))].filter(epic => matchesEpicFilter(epic, filters.value)) : [])
  const activeRuns = useQuery(computed(() => ({ ...runsQuery({ active: true }), enabled: view.value === 'top' })))
  const parentCards = computed(() => visibleEpics.value.map((epic) => {
    const stage = epicStage(epic, all.value.filter(t => t.epicId === epic.id && t.status !== 'backlog'))
    return { epic, stage, workingAgents: epicWorkingAgents(epic.id, all.value, activeRuns.data.value ?? [], shell.agents), waitingOn: stage === 'done' ? [] : unfinishedPrerequisites(epic, liveEpics.value) }
  }).filter(card => matchesParentFilter(card, parents.value.find(p => p.id === card.epic.taskId), filters.value)))

  // The Status filter hides the columns it doesn't select
  const shownColumns = computed(() => filters.value.statuses.length > 0 ? BOARD_COLUMNS.filter(c => filters.value.statuses.includes(c.key)) : BOARD_COLUMNS)
  const columns = computed(() => shownColumns.value.map((c) => {
    const entries = columnEntries(c.key, visible.value.filter(t => c.statuses.includes(t.status)), parentCards.value.filter(card => parentColumn(card.stage) === c.key))
    return { ...c, color: STATUS_DOT[STATUS[c.statuses[0]!].color], ...entries, count: entries.tasks.length + entries.cards.length }
  }))
  const total = computed(() => visible.value.length + visibleEpics.value.length)

  return { slug, all, filters, view, search, columns, total, single, epicLabel, epicOptions, taskAgents, loading, error, refetch }
}

export type Board = ReturnType<typeof useBoard>
