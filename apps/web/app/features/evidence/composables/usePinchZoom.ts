import { computed, ref, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'

// Pinch to zoom an image on a touch screen, inside its frame, since the app's
// viewport turns off the browser's own zoom. Two fingers zoom about their
// midpoint, one finger pans while zoomed, and a double tap zooms in or back
// out. Unzoomed, a sideways swipe of 50px or more is handed to `onSwipe`.
export const MAX_SCALE = 5
const DOUBLE_TAP_MS = 300
const SWIPE_PX = 50
const TAP_PX = 10

interface Zoom { scale: number, x: number, y: number }
interface Point { x: number, y: number }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

// Keeps the zoomed image covering its frame: it can pan only as far as its edges
export function bounded(zoom: Zoom, frame: { width: number, height: number }): Zoom {
  const scale = clamp(zoom.scale, 1, MAX_SCALE)
  const maxX = (frame.width * (scale - 1)) / 2
  const maxY = (frame.height * (scale - 1)) / 2
  return { scale, x: clamp(zoom.x, -maxX, maxX), y: clamp(zoom.y, -maxY, maxY) }
}

// The zoom after a pinch from `from` to `to` (each a pair of fingers, relative
// to the frame's centre): the point under the fingers' midpoint stays under it
export function pinched(start: Zoom, from: [Point, Point], to: [Point, Point]): Zoom {
  const distance = (p: [Point, Point]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)
  const middle = (p: [Point, Point]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 })
  const scale = clamp(start.scale * distance(to) / Math.max(distance(from), 1), 1, MAX_SCALE)
  const a = middle(from)
  const b = middle(to)
  const ratio = scale / start.scale
  return { scale, x: b.x - (a.x - start.x) * ratio, y: b.y - (a.y - start.y) * ratio }
}

// `canZoom` is false for files that aren't images: they only swipe
export function usePinchZoom(frame: Ref<HTMLElement | null>, onSwipe: (direction: -1 | 1) => void, canZoom: () => boolean = () => true) {
  const zoom = ref<Zoom>({ scale: 1, x: 0, y: 0 })
  const zoomed = computed(() => zoom.value.scale > 1)
  const style = computed(() => zoomed.value
    ? { transform: `translate(${zoom.value.x}px, ${zoom.value.y}px) scale(${zoom.value.scale})` }
    : {})

  let pinch: { start: Zoom, from: [Point, Point] } | null = null
  let pan: { start: Zoom, from: Point } | null = null
  let swipe: Point | null = null
  // Where a one-finger touch began, to tell a tap from a drag
  let down: Point | null = null
  let lastTap = Number.NEGATIVE_INFINITY

  const size = () => frame.value?.getBoundingClientRect() ?? new DOMRect()
  // Relative to the frame's centre, where the image scales from
  const point = (touch: Touch): Point => {
    const rect = size()
    return { x: touch.clientX - rect.left - rect.width / 2, y: touch.clientY - rect.top - rect.height / 2 }
  }
  const pair = (touches: TouchList): [Point, Point] => [point(touches[0]!), point(touches[1]!)]
  const set = (next: Zoom) => {
    zoom.value = next.scale <= 1.01 ? { scale: 1, x: 0, y: 0 } : bounded(next, size())
  }
  function reset() {
    zoom.value = { scale: 1, x: 0, y: 0 }
    pinch = pan = swipe = down = null
  }

  useEventListener(frame, 'touchstart', (event: TouchEvent) => {
    if ((event.touches?.length ?? 0) >= 2) {
      swipe = down = null
      if (!canZoom()) return
      pinch = { start: zoom.value, from: pair(event.touches) }
      pan = swipe = null
    } else if ((event.touches?.length ?? 0) === 1) {
      const touch = point(event.touches[0]!)
      down = touch
      if (zoomed.value) pan = { start: zoom.value, from: touch }
      else swipe = touch
    }
  }, { passive: true })

  // Not passive: a pinch or a pan is the image's, not the page's
  useEventListener(frame, 'touchmove', (event: TouchEvent) => {
    if (pinch && (event.touches?.length ?? 0) >= 2) {
      event.preventDefault()
      set(pinched(pinch.start, pinch.from, pair(event.touches)))
    } else if (pan && (event.touches?.length ?? 0) === 1) {
      event.preventDefault()
      const at = point(event.touches[0]!)
      set({ ...pan.start, x: pan.start.x + at.x - pan.from.x, y: pan.start.y + at.y - pan.from.y })
    }
  }, { passive: false })

  useEventListener(frame, 'touchend', (event: TouchEvent) => {
    const touch = event.changedTouches[0]
    if (pinch) {
      // Lifting one finger of two carries on as a pan
      pinch = null
      if ((event.touches?.length ?? 0) === 1 && zoomed.value) pan = { start: zoom.value, from: point(event.touches[0]!) }
      return
    }
    pan = null
    if ((event.touches?.length ?? 0) > 0 || !touch) return
    const at = point(touch)
    const start = down
    down = null
    if (swipe) {
      const dx = at.x - swipe.x
      const dy = at.y - swipe.y
      swipe = null
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
        onSwipe(dx < 0 ? 1 : -1)
        return
      }
    }
    if (!canZoom() || !start || Math.hypot(at.x - start.x, at.y - start.y) > TAP_PX) return
    const now = performance.now()
    if (now - lastTap < DOUBLE_TAP_MS) {
      lastTap = Number.NEGATIVE_INFINITY
      if (zoomed.value) reset()
      else set({ scale: 2, x: -at.x, y: -at.y })
    } else {
      lastTap = now
    }
  })

  return { zoom, zoomed, style, reset }
}
