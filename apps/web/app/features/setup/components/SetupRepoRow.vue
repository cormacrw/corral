<script setup lang="ts">
import type { RepoChoice } from '@corral/contracts'
import { repoBlockedReason } from '~/features/setup/utils/onboarding'
import { timeAgo } from '~/utils/labels'

const props = defineProps<{ repo: RepoChoice, selected: boolean }>()
defineEmits<{ pick: [] }>()
const { isMobile } = useDevice()
const owner = computed(() => props.repo.nameWithOwner.split('/')[0])
const name = computed(() => props.repo.nameWithOwner.split('/')[1])
const blocked = computed(() => repoBlockedReason(props.repo))
</script>

<template>
  <button
    type="button"
    role="option"
    :aria-selected="selected"
    :disabled="!repo.selectable"
    :class="['flex w-full items-start gap-2 border-b border-border px-3 text-start text-sm disabled:opacity-60', isMobile ? 'py-3' : 'py-2', selected ? 'bg-primary/10 ring-1 ring-primary ring-inset' : 'hover:bg-muted active:bg-muted']"
    @click="$emit('pick')"
  >
    <Icon
      :name="repo.isPrivate ? 'i-hugeicons-square-lock-02' : 'i-hugeicons-book-open-01'"
      class="mt-0.5 size-4 shrink-0 text-muted-foreground"
    />
    <span class="min-w-0 flex-1">
      <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="truncate"><span class="text-muted-foreground">{{ owner }}/</span><span class="font-semibold">{{ name }}</span></span>
        <AppBadge
          :label="repo.isPrivate ? 'Private' : 'Public'"
          :size="isMobile ? 'sm' : 'xs'"
          variant="subtle"
          color="neutral"
        />
      </span>
      <span
        v-if="repo.description"
        class="block truncate text-xs text-muted-foreground"
      >{{ repo.description }}</span>
      <span
        v-if="blocked"
        class="block text-xs text-warning"
      >{{ blocked }}</span>
      <span
        v-if="isMobile"
        class="block text-xs text-muted-foreground"
      >
        Updated {{ timeAgo(repo.updatedAt) }} · <span class="font-mono">{{ repo.defaultBranch }}</span>
      </span>
    </span>
    <span
      v-if="!isMobile"
      class="shrink-0 text-end text-xs text-muted-foreground"
    >
      Updated {{ timeAgo(repo.updatedAt) }}<br><span class="font-mono">{{ repo.defaultBranch }}</span>
    </span>
    <Icon
      v-if="selected"
      name="i-hugeicons-tick-02"
      class="mt-0.5 size-4 shrink-0 text-brand"
    />
  </button>
</template>
