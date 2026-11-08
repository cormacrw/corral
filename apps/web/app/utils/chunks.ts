import { defineAsyncComponent, type Component } from 'vue'

// A heavy part of a page (the task's rich text editor, the epic graph), loaded
// when it is first shown. Doesn't hold up the page around it, as a Lazy
// component would: the page shows and this part fills in. A chunk that fails has usually been replaced by a
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
