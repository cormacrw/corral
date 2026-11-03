import { onBeforeUnmount, ref, watch } from 'vue'

interface ThreadScrollState {
  threadId?: string
  messageId?: string
  human?: boolean
  questionId?: string
  revision?: unknown
}

// One policy for Plan and both Inbox layouts. The content wrapper (rather
// than the fixed-height viewport) tells us when images or markdown settle.
export function usePlanThreadScroll(state: () => ThreadScrollState) {
  const log = ref<HTMLElement | null>(null)
  const content = ref<HTMLElement | null>(null)
  let following = true
  let questionId: string | undefined
  let appliedTop = 0
  let observer: ResizeObserver | undefined

  function position() {
    const el = log.value
    if (!el) return
    const question = questionId
      ? Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(row => row.dataset.messageId === questionId)
      : undefined
    if (question) {
      el.scrollTop += question.getBoundingClientRect().top - el.getBoundingClientRect().top - 16
      following = el.scrollHeight - el.scrollTop - el.clientHeight < 64
    } else if (following) {
      el.scrollTop = el.scrollHeight
    }
    appliedTop = el.scrollTop
  }

  function onLogScroll() {
    const el = log.value
    // Ignore the scroll event dispatched by our own positioning. In
    // particular a tall question intentionally leaves us far from the end.
    if (!el || el.scrollTop === appliedTop) return
    questionId = undefined
    following = el.scrollHeight - el.scrollTop - el.clientHeight < 64
    appliedTop = el.scrollTop
  }

  watch(() => {
    const s = state()
    return [s.threadId, s.messageId, s.human, s.questionId, s.revision] as const
  }, (current, previous) => {
    if (previous && current.every((value, index) => Object.is(value, previous[index]))) return
    const [thread, message, human, question] = current
    const opening = !previous || thread !== previous[0]
    const newMessage = message !== previous?.[1]
    if (opening || (newMessage && human)) {
      following = true
      questionId = undefined
    } else if (newMessage) {
      questionId = question
      if (question) following = false
    }
    position()
  }, { immediate: true, flush: 'post' })

  watch([log, content], () => {
    observer?.disconnect()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(position)
      if (content.value) observer.observe(content.value)
      if (log.value) observer.observe(log.value)
    }
    position()
  }, { flush: 'post' })
  onBeforeUnmount(() => observer?.disconnect())

  return { log, content, onLogScroll }
}
