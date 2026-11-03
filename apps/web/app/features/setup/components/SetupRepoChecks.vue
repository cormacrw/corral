<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'

const props = defineProps<{ setup: Setup }>()
const { picked, check, checking } = props.setup
const { isMobile } = useDevice()
</script>

<template>
  <div :class="isMobile && 'overflow-hidden rounded-md border border-border'">
    <p :class="['text-sm font-medium', isMobile ? 'border-b border-border bg-muted/50 px-3 py-2' : 'mb-1']">
      Setup checks for {{ picked?.nameWithOwner }}
    </p>
    <div :class="isMobile && 'p-3'">
      <UiSkeleton
        v-if="checking"
        class="h-16 w-full"
      />
      <ul
        v-else-if="check"
        :class="['flex flex-col text-sm', isMobile ? 'gap-3' : 'gap-1']"
      >
        <li
          v-for="c in check.checks"
          :key="c.id"
          class="flex items-start gap-2"
        >
          <Icon
            :name="c.ok ? 'i-hugeicons-checkmark-circle-02' : 'i-hugeicons-cancel-circle'"
            :class="['mt-0.5 size-4 shrink-0', c.ok ? 'text-success' : 'text-destructive']"
          />
          <span :class="isMobile && '*:block'"><span class="font-medium">{{ c.title }}</span> <span :class="['text-muted-foreground', isMobile && 'text-xs']">{{ c.detail }}</span></span>
        </li>
        <li class="flex items-start gap-2">
          <Icon
            name="i-hugeicons-information-circle"
            class="mt-0.5 size-4 shrink-0 text-info"
          />
          <span :class="['text-muted-foreground', isMobile && 'text-xs']">Agents read .corral/ from the repository when it exists; nothing is written to the repository during setup.</span>
        </li>
      </ul>
    </div>
  </div>
</template>
