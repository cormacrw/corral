import { boardView, filtersFromQuery, filtersToQuery } from '~/features/board/utils/board'
import type { BoardFilters, BoardView } from '~/features/board/utils/board'

// The filters live in the URL query, so a filtered Board reloads and shares
export function useBoardRouteState() {
  const route = useRoute()
  const router = useRouter()
  // They're held here too: the query only updates once the navigation lands,
  // so quick changes (picking two options, typing) would otherwise build on a
  // stale query and drop one another.
  const filters = ref<BoardFilters>(filtersFromQuery(route.query))
  // The view toggle is shared across layouts. ?view= wins over the view last
  // used, and the URL's view counts as used.
  // A new key, so a stored view from before parent tasks doesn't choose for anyone.
  const lastView = useLocalStorage<BoardView>('corral.board.scope', 'top')
  const view = ref(boardView(route.query.view, boardView(lastView.value, 'top')))
  watch(view, (next) => {
    lastView.value = next
  }, { immediate: true })
  // The Board filters at once; the URL catches up after a pause in typing, since
  // each write is a navigation.
  const URL_WRITE_MS = 200
  let writing = 0
  let urlWrite: ReturnType<typeof setTimeout> | null = null
  watch([filters, view], ([next, nextView]) => {
    if (urlWrite) clearTimeout(urlWrite)
    else writing++
    urlWrite = setTimeout(async () => {
      urlWrite = null
      try {
        await router.replace({ query: { ...filtersToQuery(next, route.query), view: nextView } })
      } finally {
        writing--
      }
    }, URL_WRITE_MS)
  })
  onBeforeUnmount(() => {
    if (urlWrite) clearTimeout(urlWrite)
  })
  // Back, forward and links change the query from outside
  watch(() => route.query, (query) => {
    if (writing) return
    const next = filtersFromQuery(query)
    if (JSON.stringify(next) !== JSON.stringify(filters.value)) filters.value = next
    view.value = boardView(query.view, view.value)
  })
  const search = computed({
    get: () => filters.value.search,
    set: (value: string) => { filters.value = { ...filters.value, search: value } }
  })
  return { filters, view, search }
}
