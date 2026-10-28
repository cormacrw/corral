<script setup lang="ts">
import type { Plan } from '@corral/contracts'

// A plan version inside Juno's message (design/plan.md)
const props = defineProps<{ plan: Plan, previous: Plan | null, busy: boolean }>()
const emit = defineEmits<{ approve: [], open: [ref: string] }>()
const flyout = useTaskFlyout()
const showDiff = ref(false)

const changeColor = { added: 'success', changed: 'warning', unchanged: 'neutral', removed: 'error' } as const
const criteria = computed(() => props.plan.tasks.filter(t => t.change !== 'removed').reduce((n, t) => n + t.criteriaCount, 0))
const taskCount = computed(() => props.plan.tasks.filter(t => t.change !== 'removed').length)
const changed = computed(() => props.plan.tasks.filter(t => t.change !== 'unchanged'))
</script>

<template>
  <section
    :aria-label="`Plan v${props.plan.version}: ${props.plan.title}`"
    class="overflow-hidden rounded-lg border border-default"
  >
    <header class="flex flex-wrap items-center gap-2 bg-muted px-3 py-2 text-sm">
      <span class="font-medium">Plan v{{ props.plan.version }} · {{ props.plan.title }}</span>
      <UBadge
        :label="props.plan.status === 'approved' ? 'Approved' : props.plan.status === 'superseded' ? 'Superseded' : 'Waiting for approval'"
        :color="props.plan.status === 'approved' ? 'success' : props.plan.status === 'superseded' ? 'neutral' : 'primary'"
        variant="subtle"
        size="sm"
      />
      <span class="ms-auto text-xs text-muted">{{ taskCount }} tasks · {{ criteria }} criteria</span>
    </header>
    <ul class="divide-y divide-default">
      <li
        v-for="task in props.plan.tasks"
        :key="task.key"
      >
        <button
          type="button"
          :disabled="task.change === 'removed' || !task.ref"
          :class="['flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-elevated disabled:cursor-default disabled:hover:bg-transparent', task.ref && flyout.ref.value === task.ref && 'bg-elevated']"
          @click="task.ref && emit('open', task.ref)"
        >
          <UBadge
            :label="task.change[0]!.toUpperCase() + task.change.slice(1)"
            :color="changeColor[task.change]"
            variant="subtle"
            size="xs"
            class="w-20 justify-center"
          />
          <span :class="['min-w-0 flex-1 truncate', task.change === 'removed' && 'line-through text-muted']">
            <span
              v-if="task.ref"
              class="me-1 font-mono text-xs text-muted"
            >{{ task.ref }}</span>{{ task.title }}
          </span>
          <span class="shrink-0 text-xs text-muted">
            {{ task.criteriaCount }} criteria<span v-if="task.dependsOn.length"> · after {{ task.dependsOn.join(', ') }}</span>
          </span>
        </button>
      </li>
    </ul>
    <footer class="flex flex-wrap items-center gap-2 border-t border-default px-3 py-2 text-sm">
      <template v-if="props.plan.status === 'proposed'">
        <UButton
          label="Approve plan"
          :loading="props.busy"
          @click="emit('approve')"
        />
        <UButton
          v-if="props.previous"
          :label="`Changes from v${props.previous.version}`"
          variant="outline"
          color="neutral"
          :aria-pressed="showDiff"
          @click="showDiff = !showDiff"
        />
        <span class="text-xs text-muted">Approving moves these tasks from Backlog to Ready.</span>
      </template>
      <span
        v-else-if="props.plan.status === 'approved'"
        class="text-success"
      >✓ Approved. {{ taskCount }} tasks moved to Ready and onto the board.</span>
      <span
        v-else
        class="text-muted"
      >Replaced by a later version.</span>
    </footer>
    <div
      v-if="showDiff"
      class="border-t border-default bg-muted px-3 py-2 text-xs text-muted"
    >
      <span v-if="changed.length === 0">Nothing changed.</span>
      <span v-else>{{ changed.map(t => `${t.change} ${t.title}`).join(' · ') }}</span>
    </div>
  </section>
</template>
