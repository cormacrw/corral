import { errorMessage } from '~/lib/errors'
import { useMutation } from '@tanstack/vue-query'
import type { Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'
import { BOARD_COLUMNS, boardMove } from '~/features/board/utils/board'
import { moveTask } from '~/queries/tasks'

// Human moves on the web Board, through the same actions as the Status menu.
// The server remains authoritative.
export function useBoardDrag() {
  const { slug } = useProject()
  const toast = useToast()
  const move = useMutation(moveTask)
  const moving = ref(new Set<string>())
  const dragged = ref<Task | null>(null)
  const canDrag = (task: Task) => BOARD_COLUMNS.some(column => boardMove(task, column.statuses[0]!))
  const canDrop = (status: TaskStatus) => Boolean(dragged.value && boardMove(dragged.value, status))
  function startDrag(event: DragEvent, task: Task) {
    if (moving.value.has(task.id)) {
      event.preventDefault()
      return
    }
    dragged.value = task
    event.dataTransfer?.setData('text/plain', task.ref)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }
  function allowDrop(event: DragEvent, status: TaskStatus) {
    if (canDrop(status)) {
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    }
  }
  async function dropTask(event: DragEvent, status: TaskStatus) {
    event.preventDefault()
    const task = dragged.value
    dragged.value = null
    if (!task || moving.value.has(task.id)) return
    const input = boardMove(task, status)
    if (!input) return
    moving.value.add(task.id)
    try {
      await move.mutateAsync({ task: { ...task, slug: slug.value }, input, status })
    } catch (e) {
      toast.add({ title: `Could not move ${task.ref}`, description: errorMessage(e), color: 'error' })
    } finally {
      moving.value.delete(task.id)
    }
  }
  return { moving, dragged, canDrag, canDrop, startDrag, allowDrop, dropTask }
}
