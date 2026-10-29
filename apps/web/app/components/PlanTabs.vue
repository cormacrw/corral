<script setup lang="ts">
import type { PlanSession } from '@corral/contracts'
import { projectColor } from '~/utils/labels'

// The sessions you have open, as tabs above Plan (design/plan.md). Status
// comes from live.state.planSessions, which plan.session events keep current.
const live = useLive()
const router = useRouter()
const { active, sessions, close } = useOpenPlanSessions()
const projectOf = (session: PlanSession) => live.state.value.projects.find(p => p.id === session.projectId) ?? null

// Arrow keys move between tabs (the last one is +); Enter or Space opens one
const strip = ref<HTMLElement | null>(null)
function onKey(event: KeyboardEvent) {
  const all = Array.from(strip.value?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
  const index = all.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  let next: number | null = null
  if (event.key === 'ArrowRight') next = (index + 1) % all.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + all.length) % all.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = all.length - 1
  else if (event.key === 'Delete' && index < sessions.value.length) {
    event.preventDefault()
    void close(sessions.value[index]!)
    return
  }
  if (next === null) return
  event.preventDefault()
  all[next]!.focus()
}
// One tab stop: the active tab, or + on a new session
const focusable = (id: string | null) => id === active.value
</script>

<template>
  <div
    ref="strip"
    role="tablist"
    aria-label="Open sessions"
    class="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-default bg-muted/40 px-2 pt-1"
    @keydown="onKey"
  >
    <div
      v-for="session in sessions"
      :key="session.id"
      :class="[
        'group flex h-full max-w-56 min-w-0 shrink-0 items-center rounded-t-md border border-b-0 text-sm',
        session.id === active ? 'border-default bg-default' : 'border-transparent text-muted hover:bg-elevated'
      ]"
    >
      <button
        type="button"
        role="tab"
        :aria-selected="session.id === active"
        :tabindex="focusable(session.id) ? 0 : -1"
        aria-keyshortcuts="Delete"
        :title="session.title"
        class="flex h-full min-w-0 flex-1 items-center gap-2 ps-3 pe-1 focus-visible:outline-2 focus-visible:outline-primary"
        @click="router.push(`/plan/${session.id}`)"
      >
        <span
          class="size-2 shrink-0 rounded-full"
          :style="{ background: projectOf(session) ? projectColor(projectOf(session)!) : '#999' }"
          aria-hidden="true"
        />
        <span :class="['truncate', session.unread && 'font-semibold text-highlighted']">{{ session.title }}</span>
        <UIcon
          v-if="session.activeRunId"
          name="i-lucide-loader-circle"
          class="size-3.5 shrink-0 animate-spin text-muted"
        />
        <span
          v-if="session.activeRunId"
          class="sr-only"
        >, working</span>
        <span
          v-if="session.status === 'needs_approval'"
          class="size-2 shrink-0 rounded-full bg-primary"
          title="Needs approval"
        ><span class="sr-only">, needs approval</span></span>
        <span
          v-else-if="session.status === 'question'"
          class="size-2 shrink-0 rounded-full bg-info"
          title="Question"
        ><span class="sr-only">, question</span></span>
        <span
          v-if="session.unread"
          class="size-1.5 shrink-0 rounded-full bg-inverted"
          title="Unread"
        ><span class="sr-only">, unread</span></span>
      </button>
      <UButton
        icon="i-lucide-x"
        size="xs"
        variant="ghost"
        color="neutral"
        :tabindex="session.id === active ? 0 : -1"
        :aria-label="`Close ${session.title}`"
        :class="['me-1 shrink-0', session.id !== active && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100']"
        @click="close(session)"
      />
    </div>
    <button
      type="button"
      role="tab"
      :aria-selected="active === null"
      :tabindex="focusable(null) ? 0 : -1"
      aria-label="New session"
      title="New session"
      :class="[
        'flex h-full shrink-0 items-center rounded-t-md border border-b-0 px-2.5 focus-visible:outline-2 focus-visible:outline-primary',
        active === null ? 'border-default bg-default' : 'border-transparent text-muted hover:bg-elevated'
      ]"
      @click="router.push('/plan')"
    >
      <UIcon
        name="i-lucide-plus"
        class="size-4"
      />
    </button>
  </div>
</template>
