<script setup lang="ts">
import type { Project, Run } from '@corral/contracts'
import { isActiveRun } from '@corral/core'
import { duration, projectColor, runRef, runTitle, timeAgo } from '~/utils/labels'

// One run in an agent's runs list (design/agent.md): ref and when, title,
// "{project dot} project · Run #n · duration" and any error. No outcome dot
// or tag: outcome colour belongs to the charts. On the dashboard a live run
// gets a Live badge and shows how long it has been running.
const props = defineProps<{ run: Run, project: Pick<Project, 'name' | 'thumbnailColor'> | null, now: number, selected?: boolean, dashboard?: boolean }>()
defineEmits<{ click: [] }>()
const live = computed(() => isActiveRun(props.run.state))
const meta = computed(() => [props.project?.name, `Run #${props.run.number}`, duration(props.run.startedAt, props.run.endedAt, props.now)].filter(Boolean).join(' · '))
</script>

<template>
  <button
    type="button"
    :aria-current="selected ? 'true' : undefined"
    :data-live="live || undefined"
    :class="['flex w-full flex-col gap-0.5 text-start text-sm', dashboard ? 'px-4 py-2.5 hover:bg-muted/60' : 'border-b border-border px-3 py-2', selected && 'bg-muted', live && 'border-s-2 border-s-primary', live && dashboard && 'bg-primary/5']"
    @click="$emit('click')"
  >
    <span class="flex items-center gap-2">
      <span class="font-mono text-xs text-muted-foreground">{{ runRef(run) }}</span>
      <AppBadge
        v-if="live && dashboard"
        label="Live"
        color="primary"
        variant="subtle"
        size="sm"
      />
      <span class="ms-auto text-xs tabular-nums text-muted-foreground/70">{{ live && dashboard ? duration(run.startedAt, null, now) : timeAgo(run.queuedAt, now) }}</span>
    </span>
    <span class="truncate">{{ runTitle(run) }}</span>
    <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span
        v-if="project"
        class="size-2 shrink-0 rounded-full"
        :style="{ backgroundColor: projectColor(project) }"
        data-testid="project-dot"
        aria-hidden="true"
      />
      <span class="truncate">{{ meta }}</span>
    </span>
    <span
      v-if="run.error"
      :class="['text-xs text-destructive', dashboard ? 'line-clamp-2' : 'line-clamp-3']"
      :title="run.error"
    >{{ run.error }}</span>
  </button>
</template>
