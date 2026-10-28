export default defineAppConfig({
  ui: {
    colors: {
      primary: 'teal',
      neutral: 'slate'
    },
    // The dashboard fills what's left under a status banner (stopped, paused,
    // runner offline) instead of covering the whole viewport and hiding it
    dashboardGroup: {
      base: 'relative inset-auto min-h-0 flex-1'
    },
    dashboardPanel: {
      slots: { root: 'min-h-0' }
    },
    dashboardSidebar: {
      slots: { root: 'min-h-0' }
    }
  }
})
