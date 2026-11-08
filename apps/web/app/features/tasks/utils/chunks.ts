// Opening a task loads Tiptap and ProseMirror with these
export const loadTaskDetail = () => import('~/features/tasks/components/TaskDetail.vue')
export const loadTaskDescription = () => import('~/features/tasks/components/TaskDescription.vue')

export function preloadTaskChunks(): void {
  Promise.all([loadTaskDetail(), loadTaskDescription()]).catch(() => {
    // Opening it tries again
  })
}
