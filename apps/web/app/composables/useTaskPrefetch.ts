import { useQueryClient } from '@tanstack/vue-query'
import type { Task } from '@corral/contracts'
import { taskCommentsQuery, taskQuery } from '~/queries/tasks'
import { preloadTaskChunks } from '~/utils/chunks'

// Long enough that moving the pointer across a list asks for nothing
const HOVER_MS = 100

// Listeners for a row that opens a task: resting a mouse on it fetches what
// the flyout needs ahead of the click. Touch has no hover, so it's skipped.
export function useTaskPrefetch() {
  const client = useQueryClient()
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => clearTimeout(timer)
  onBeforeUnmount(cancel)
  return (task: Pick<Task, 'ref' | 'number'>, slug: string) => ({
    onPointerenter: (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return
      cancel()
      timer = setTimeout(() => {
        preloadTaskChunks()
        void client.prefetchQuery(taskQuery(task.ref))
        void client.prefetchQuery(taskCommentsQuery({ slug, number: task.number, ref: task.ref }))
      }, HOVER_MS)
    },
    onPointerleave: cancel
  })
}
