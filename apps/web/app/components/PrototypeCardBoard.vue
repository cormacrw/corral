<script setup lang="ts">
import { BOARD_COLUMNS } from '~/utils/board'
import { STATUS } from '~/utils/labels'

const route = useRoute()
const router = useRouter()
const live = useLive()
const device = useDevice()
const flyout = useTaskFlyout()
// The blocked icon is still being tried out, so the Board can show each one
const blockedIcons = [
  { id: 'ban', label: 'Ban', icon: 'i-lucide-ban' },
  { id: 'hourglass', label: 'Hourglass', icon: 'i-lucide-hourglass' },
  { id: 'lock', label: 'Lock', icon: 'i-lucide-lock' },
  { id: 'link', label: 'Link', icon: 'i-lucide-link-2' }
]
const blockedIcon = computed(() => blockedIcons.find(i => i.id === route.query.blocked) ?? blockedIcons[0]!)
const all = computed(() => live.state.value.tasks['p-corral'] ?? [])
const columnKey = computed(() => String(route.query.column ?? 'in_progress'))
const columns = computed(() => BOARD_COLUMNS.filter(c => !device.isMobile.value || c.key === columnKey.value))
const preview = computed(() => typeof route.query.selected === 'string' ? route.query.selected : 'COR-24')
const selected = (ref: string) => (flyout.ref.value ?? preview.value) === ref
function open(ref: string) {
  if (flyout.ref.value === ref) void flyout.close()
  else flyout.open(ref, { replace: device.isMobile.value })
}
function query(values: Record<string, string>) {
  void router.replace({ query: { ...route.query, ...values } })
}
const colors: Record<string, string> = { neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-error', success: 'bg-success', secondary: 'bg-secondary' }
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <div class="flex h-full min-h-0 flex-col">
      <header class="shrink-0 border-b border-default px-4 py-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <p class="text-xs font-medium tracking-wide text-muted">
            COR-154 / BOARD CARD
          </p><UBadge
            label="Prototype"
            color="neutral"
            variant="subtle"
            size="sm"
          />
        </div>
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 class="text-base font-semibold text-highlighted">
            Option A
          </h1><p class="text-xs text-muted">
            Title, epic, then priority on the left with the type, blocked and assignee icons on the right.
          </p>
        </div>
        <nav
          aria-label="Blocked icon"
          class="mt-2 flex flex-wrap items-center gap-1.5"
        >
          <span class="me-1 text-xs text-muted">Blocked icon</span>
          <UButton
            v-for="i in blockedIcons"
            :key="i.id"
            :label="i.label"
            :icon="i.icon"
            :variant="blockedIcon.id === i.id ? 'solid' : 'outline'"
            :color="blockedIcon.id === i.id ? 'primary' : 'neutral'"
            size="xs"
            :aria-pressed="blockedIcon.id === i.id"
            @click="query({ blocked: i.id })"
          />
        </nav>
      </header>
      <nav
        v-if="device.isMobile.value"
        aria-label="Board columns"
        class="flex shrink-0 gap-2 overflow-x-auto border-b border-default p-3"
      >
        <UButton
          v-for="c in BOARD_COLUMNS"
          :key="c.key"
          :label="c.label"
          :variant="columnKey === c.key ? 'soft' : 'ghost'"
          color="neutral"
          class="shrink-0"
          @click="query({ column: c.key })"
        />
      </nav>
      <div class="relative flex min-h-0 flex-1">
        <div
          role="region"
          aria-label="Board columns"
          class="flex min-w-0 flex-1 items-start gap-3 overflow-auto p-4"
        >
          <section
            v-for="column in columns"
            :key="column.key"
            :aria-label="column.label"
            :class="['flex max-h-full shrink-0 flex-col rounded-lg border border-default bg-muted', device.isMobile.value ? 'w-full' : 'w-[272px]']"
          >
            <header class="flex items-center gap-2 px-3 py-3 text-sm">
              <span :class="['size-2 rounded-full', colors[STATUS[column.statuses[0]!].color]]" /><h2 class="font-medium">
                {{ column.label }}
              </h2><UBadge
                :label="String(all.filter(t => column.statuses.includes(t.status)).length)"
                color="neutral"
                variant="subtle"
                size="xs"
              /><span class="ms-auto text-xs text-muted">{{ column.hint }}</span>
            </header>
            <div class="flex min-h-0 flex-col gap-2 overflow-y-auto p-2">
              <PrototypeTaskCard
                v-for="task in all.filter(t => column.statuses.includes(t.status))"
                :key="task.id"
                :task="task"
                :all="all"
                :blocked-icon="blockedIcon.icon"
                :selected="selected(task.ref)"
                @open="open(task.ref)"
                @open-blocker="open"
              />
              <p
                v-if="!all.some(t => column.statuses.includes(t.status))"
                class="p-2 text-xs text-muted"
              >
                Nothing here
              </p>
            </div>
          </section>
        </div>
        <div
          v-if="flyout.ref.value"
          :class="device.isMobile.value ? 'absolute inset-0 z-10 bg-default [&>aside]:!w-full' : 'h-full shrink-0'"
        >
          <TaskFlyout />
        </div>
      </div>
    </div>
  </UDashboardPanel>
</template>
