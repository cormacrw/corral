import { defineAsyncComponent, type Component } from 'vue'

// The heavy parts of a page, loaded when they are first shown: the task's rich
// text editor (Tiptap, ProseMirror) and the epic graph (Vue Flow).
export const loadTaskDetail = () => import('~/components/TaskDetail.vue')
export const loadTaskDescription = () => import('~/components/TaskDescription.vue')
export const loadEpicDetail = () => import('~/components/EpicDetail.vue')
export const loadEpicGraph = () => import('~/components/EpicGraph.vue')

// Doesn't hold up the page around it, as a Lazy component would: the page shows
// and this part fills in. A chunk that fails has usually been replaced by a
// deploy, and reloading gets the new one.
export const asyncChunk = (loader: () => Promise<{ default: Component }>, loadingComponent: Component) => defineAsyncComponent({
  loader: () => loader().catch((error) => {
    reloadNuxtApp()
    throw error
  }),
  loadingComponent,
  delay: 0,
  suspensible: false
})

// Fetches what opening a task needs, ahead of the click
export function preloadTaskChunks(): void {
  Promise.all([loadTaskDetail(), loadTaskDescription()]).catch(() => {
    // Opening it tries again
  })
}
