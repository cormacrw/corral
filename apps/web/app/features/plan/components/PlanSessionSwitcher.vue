<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { planSessionsQuery } from '~/queries/plan'
import type { PlanSession } from '@corral/contracts'
import { projectColor } from '~/utils/labels'
import { PLAN_STATUS_BADGE } from '~/features/plan/utils/plan-attention'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// The mobile session switcher (design/plan.md, design/mobile.md): a header
// button that opens a sheet of the open sessions, with their status and a
// close button each, then every other session to resume.
const shell = useShell()
const router = useRouter()
const { active, sessions, close } = useOpenPlanSessions()
const open = ref(false)
const allSessions = useQuery(planSessionsQuery()).data

const others = computed(() => {
  const shown = new Set(sessions.value.map(s => s.id))
  return (allSessions.value ?? []).filter(s => !shown.has(s.id))
})
const projectOf = (session: PlanSession) => shell.projects.find(p => p.id === session.projectId) ?? null
const dotColor = (session: PlanSession) => {
  const project = projectOf(session)
  return project ? projectColor(project) : 'var(--muted-foreground)'
}
const needsYou = computed(() => sessions.value.some(s => s.unread || s.status !== 'none'))

async function go(to: string) {
  open.value = false
  await router.push(to)
}
</script>

<template>
  <AppDrawer
    v-model:open="open"
    title="Sessions"
  >
    <span class="relative">
      <AppButton
        icon="i-hugeicons-history"
        variant="ghost"
        color="neutral"
        aria-label="Sessions"
        data-testid="plan-session-switcher"
      />
      <span
        v-if="needsYou"
        class="pointer-events-none absolute end-1.5 top-1.5 size-2 rounded-full bg-primary"
        aria-hidden="true"
      />
    </span>
    <template #content>
      <div class="flex max-h-[80svh] min-h-0 flex-col pb-[env(safe-area-inset-bottom)]">
        <div class="flex items-center gap-2 px-4 pt-2 pb-3">
          <h2 class="flex-1 text-base font-semibold text-foreground">
            Sessions
          </h2>
          <AppButton
            label="New session"
            icon="i-hugeicons-add-01"
            size="sm"
            variant="soft"
            @click="go('/plan')"
          />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
          <section
            v-if="sessions.length > 0"
            aria-label="Open sessions"
          >
            <h3 class="px-4 pb-1 text-xs font-medium text-muted-foreground">
              Open
            </h3>
            <ul class="divide-y divide-border border-y border-border">
              <li
                v-for="session in sessions"
                :key="session.id"
                :class="['flex items-center', session.id === active && 'bg-muted']"
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-2 py-3 ps-4 text-start text-sm"
                  :aria-current="session.id === active ? 'page' : undefined"
                  @click="go(`/plan/${session.id}`)"
                >
                  <span
                    class="size-2 shrink-0 rounded-full"
                    :style="{ background: dotColor(session) }"
                    aria-hidden="true"
                  />
                  <span :class="['truncate', session.unread && 'font-semibold text-foreground']">{{ session.title }}</span>
                  <span class="text-xs text-muted-foreground">{{ projectOf(session)?.name ?? 'Global' }}</span>
                  <Icon
                    v-if="session.activeRunId"
                    name="i-hugeicons-loading-03"
                    class="size-3.5 shrink-0 animate-spin text-muted-foreground"
                  />
                  <span
                    v-if="session.activeRunId"
                    class="sr-only"
                  >, working</span>
                  <AppBadge
                    v-if="session.status !== 'none'"
                    v-bind="PLAN_STATUS_BADGE[session.status]"
                    variant="subtle"
                    size="xs"
                    class="shrink-0"
                  />
                  <span
                    v-if="session.unread"
                    class="size-1.5 shrink-0 rounded-full bg-foreground"
                    title="Unread"
                  ><span class="sr-only">, unread</span></span>
                </button>
                <AppButton
                  icon="i-hugeicons-cancel-01"
                  variant="ghost"
                  color="neutral"
                  :aria-label="`Close ${session.title}`"
                  class="me-2 shrink-0"
                  @click="close(session)"
                />
              </li>
            </ul>
          </section>
          <section
            v-if="others.length > 0"
            aria-label="Resume a session"
            class="mt-4"
          >
            <h3 class="px-4 pb-1 text-xs font-medium text-muted-foreground">
              Resume
            </h3>
            <ul class="divide-y divide-border border-y border-border">
              <li
                v-for="session in others"
                :key="session.id"
              >
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-4 py-3 text-start text-sm"
                  @click="go(`/plan/${session.id}`)"
                >
                  <span
                    class="size-2 shrink-0 rounded-full"
                    :style="{ background: dotColor(session) }"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ session.title }}</span>
                  <span class="text-xs text-muted-foreground">{{ projectOf(session)?.name ?? 'Global' }}</span>
                  <span class="shrink-0 text-xs text-muted-foreground/70"><TimeAgo :at="session.updatedAt" /></span>
                </button>
              </li>
            </ul>
          </section>
          <p
            v-if="sessions.length === 0 && others.length === 0"
            class="px-4 py-6 text-center text-sm text-muted-foreground"
          >
            No sessions yet.
          </p>
        </div>
      </div>
    </template>
  </AppDrawer>
</template>
