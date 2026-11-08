import type { Ref } from 'vue'
import type { BoardView } from '~/features/board/utils/board'
import { boardColumnKey, swipeStep } from '~/features/board/utils/board'

// The mobile Board's one open column, picked from a row of tabs or by swiping.
// Resolve against the current view's columns, so a task-only or epic-only
// key (or an unknown key) always falls back to its first visible column.
// ?column= survives navigation to task and epic pages and Back.
export function useBoardColumnTabs<C extends { key: string }>(columns: Ref<C[]>, view: Ref<BoardView>) {
  const route = useRoute()
  const router = useRouter()
  const index = computed(() => Math.max(0, columns.value.findIndex(c => c.key === boardColumnKey(route.query.column))))
  const column = computed(() => columns.value[index.value])
  function select(i: number) {
    const next = columns.value[Math.min(columns.value.length - 1, Math.max(0, i))]
    if (next && next.key !== column.value?.key) void router.replace({ query: { ...route.query, column: next.key } })
  }

  const tabs = useTemplateRef<HTMLElement[]>('tabs')
  async function scrollTab(i: number) {
    await nextTick()
    tabs.value?.[i]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }
  watch([index, view], ([i]) => void scrollTab(i))
  onMounted(() => void scrollTab(index.value))

  let start: { x: number, y: number } | null = null
  function onTouchStart(event: TouchEvent) {
    const touch = event.touches[0]
    start = touch ? { x: touch.clientX, y: touch.clientY } : null
  }
  function onTouchEnd(event: TouchEvent) {
    const touch = event.changedTouches[0]
    if (!start || !touch) return
    const step = swipeStep(touch.clientX - start.x, touch.clientY - start.y)
    start = null
    if (step) select(index.value + step)
  }
  function onTabKey(event: KeyboardEvent) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    select(index.value + step)
    void nextTick(() => tabs.value?.[index.value]?.focus())
  }
  return { index, column, select, onTouchStart, onTouchEnd, onTabKey }
}
