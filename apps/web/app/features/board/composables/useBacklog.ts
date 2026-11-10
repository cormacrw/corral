import { errorText } from '@corral/core'
import { refusedNotReady } from '~/queries/client'
import { useMutation } from '@tanstack/vue-query'
import type { Task } from '@corral/contracts'
import { backlogGroups, matchesBacklog } from '~/features/board/utils/backlog'
import { createTask, transitionTask } from '~/queries/tasks'
import { plural } from '~/utils/labels'
import { planPath, taskPath } from '~/utils/routes'

// The Backlog's data and moves (design/backlog.md): proposed tasks grouped by
// epic, shared by BacklogDesktop and BacklogMobile so both behave the same
export function useBacklog() {
  const shell = useShell()
  const flyout = useTaskFlyout()
  const device = useDevice()
  const router = useRouter()
  const toast = useToast()
  const transition = useMutation(transitionTask)
  const create = useMutation(createTask)
  const { slug, project, tasks: all, epics, loading, error, refetch, overview } = useProject()

  const search = ref('')
  const showCompleted = ref(false)
  const collapsed = useLocalStorage<Record<string, boolean>>('corral.backlog.collapsed', {})
  const rows = computed(() => all.value.filter(t => matchesBacklog(t, search.value, showCompleted.value)))
  const groups = computed(() => backlogGroups(all.value, rows.value, epics.value))
  const summary = computed(() => `${plural(rows.value.length, 'task')} · never scheduled until approved`)
  const planTo = computed(() => planPath(project.value?.id))
  const plans = computed(() => new Map(shell.planSessions.filter(s => s.status === 'needs_approval').map(s => [s.projectId, s])))
  const inPlan = (task: Task) => task.status === 'backlog' && plans.value.has(task.projectId)
  const toggle = (id: string) => {
    collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] }
  }
  const setAll = (value: boolean) => {
    collapsed.value = Object.fromEntries(groups.value.map(g => [g.id, value]))
  }

  // Backlog → Ready (D10): one task from its row, or every Backlog task in an
  // epic at once. Tasks missing what Ready needs stay put and are listed.
  const moving = ref(new Set<string>())
  async function moveToBoard(tasks: Task[]) {
    const moved: string[] = []
    const notReady: string[] = []
    for (const task of tasks) moving.value.add(task.id)
    for (const task of tasks) {
      try {
        await transition.mutateAsync({ task: { ...task, slug: slug.value }, input: { type: 'approve' } })
        moved.push(task.ref)
      } catch (e) {
        if (refusedNotReady(e)) {
          notReady.push(`${task.ref}: ${e.message}`)
        } else {
          toast.add({ title: `Could not move ${task.ref}`, description: errorText(e), color: 'error' })
        }
      } finally {
        moving.value.delete(task.id)
      }
    }
    if (moved.length > 0) toast.add({ title: moved.length === 1 ? `${moved[0]} moved to the board` : `${moved.length} tasks moved to the board`, color: 'success' })
    if (notReady.length > 0) toast.add({ title: notReady.length === 1 ? 'Not ready yet' : `${notReady.length} tasks not ready yet`, description: notReady.join('; '), color: 'warning' })
  }
  // Separate from what it holds, which stays through the close animation
  const confirmOpen = ref(false)
  const confirmEpic = ref<{ title: string, tasks: Task[] } | null>(null)
  function moveEpic(group: { id: string, title: string }) {
    const tasks = all.value.filter(t => t.status === 'backlog' && (t.epicId ?? 'none') === group.id)
    if (tasks.length === 1) void moveToBoard(tasks)
    else {
      confirmEpic.value = { title: group.title, tasks }
      confirmOpen.value = true
    }
  }
  function confirmMove() {
    void moveToBoard(confirmEpic.value!.tasks)
    confirmOpen.value = false
  }

  const creating = create.isPending
  async function newTask() {
    if (!project.value || creating.value) return
    try {
      const task = await create.mutateAsync({ slug: slug.value, input: { title: 'New task', type: 'task', description: null } })
      // A phone has no room for the flyout, so the task opens on its own page
      if (device.isMobile.value) void router.push(taskPath(task.ref))
      else flyout.open(task.ref)
    } catch (e) {
      toast.add({ title: 'Could not create the task', description: errorText(e), color: 'error' })
    }
  }

  return { slug, search, showCompleted, collapsed, groups, summary, planTo, pmName: overview.pmName, inPlan, toggle, setAll, moving, moveToBoard, moveEpic, confirmOpen, confirmEpic, confirmMove, creating, newTask, loading, error, refetch }
}

export type Backlog = ReturnType<typeof useBacklog>
