// The docked flyout opens with ?task=COR-29 or ?epic=<id> on the current
// page (design/task.md), so it survives reloads and links can be shared.
// On a Plan session, a bare ?plan shows the session's latest plan.
// It shows one thing at a time: opening a task closes an epic and back.
//
// Opening adds a browser history entry, so Back returns to what was open
// before (an epic, after opening one of its tasks). An entry opened from
// another flyout item is marked, and the flyout shows its own back arrow.
// Opening that happens on its own (the Inbox following the selected item)
// replaces the entry instead.
//
// Mobile has no flyout (design/mobile.md): opening a task or epic goes to
// its page. Opening that replaces the entry still sets the query, so a page
// following a selection doesn't navigate away by itself.
interface OpenOptions {
  replace?: boolean
}

export function useTaskFlyout() {
  const route = useRoute()
  const router = useRouter()
  const device = useDevice()
  const ref = computed(() => typeof route.query.task === 'string' ? route.query.task : null)
  const epic = computed(() => typeof route.query.epic === 'string' ? route.query.epic : null)
  const plan = computed(() => 'plan' in route.query)
  // history.state isn't reactive; reading the route makes this recompute
  const canGoBack = computed(() => {
    void route.fullPath
    return import.meta.client && window.history.state?.flyoutBack === true
  })

  function go(query: typeof route.query, options: OpenOptions) {
    // Only an entry that replaced one flyout item with another has a flyout to go back to
    const flyoutBack = Boolean(ref.value || epic.value || plan.value)
    if (options.replace) void router.replace({ query, state: { flyoutBack: canGoBack.value } })
    else void router.push({ query, state: { flyoutBack } })
  }
  function open(taskRef: string, options: OpenOptions = {}) {
    if (device.isMobile.value && !options.replace) return void router.push(`/tasks/${taskRef}`)
    const { epic: _epic, plan: _plan, ...rest } = route.query
    go({ ...rest, task: taskRef }, options)
  }
  function openEpic(epicId: string, options: OpenOptions = {}) {
    if (device.isMobile.value && !options.replace) return void router.push(`/epics/${epicId}`)
    const { task: _task, plan: _plan, ...rest } = route.query
    go({ ...rest, epic: epicId }, options)
  }
  function openPlan(options: OpenOptions = {}) {
    const { task: _task, epic: _epic, ...rest } = route.query
    go({ ...rest, plan: null }, options)
  }
  function close() {
    const { task: _task, epic: _epic, plan: _plan, ...rest } = route.query
    return router.replace({ query: rest })
  }
  function back() {
    router.back()
  }
  // Clicking the open row again closes it
  function toggle(taskRef: string) {
    if (ref.value === taskRef) close()
    else open(taskRef)
  }
  function toggleEpic(epicId: string) {
    if (epic.value === epicId) close()
    else openEpic(epicId)
  }
  return { ref, epic, plan, canGoBack, open, openEpic, openPlan, close, back, toggle, toggleEpic }
}
