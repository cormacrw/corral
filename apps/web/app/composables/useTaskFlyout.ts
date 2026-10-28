// The docked task flyout opens with ?task=COR-29 on the current page
// (design/task.md), so it survives reloads and links can be shared
export function useTaskFlyout() {
  const route = useRoute()
  const router = useRouter()
  const ref = computed(() => typeof route.query.task === 'string' ? route.query.task : null)

  function open(taskRef: string) {
    void router.replace({ query: { ...route.query, task: taskRef } })
  }
  function close() {
    const { task: _removed, ...rest } = route.query
    void router.replace({ query: rest })
  }
  // Clicking the open row again closes it
  function toggle(taskRef: string) {
    if (ref.value === taskRef) close()
    else open(taskRef)
  }
  return { ref, open, close, toggle }
}
