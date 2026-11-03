<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import type { CliStatus } from '@corral/contracts'

// The logins inside the runner, with their loading and failed states. Each
// layout renders its own row in the default slot.
defineProps<{ title: string, listClass?: HTMLAttributes['class'], skeletonClass?: HTMLAttributes['class'] }>()
defineSlots<{ default: (props: { cli: CliStatus }) => unknown }>()
const { clis, cliError, scan } = useCliScan()
</script>

<template>
  <section>
    <div class="mb-2 flex items-center">
      <h2 class="flex-1 text-sm font-semibold text-foreground">
        {{ title }}
      </h2>
      <AppButton
        label="Scan again"
        size="xs"
        variant="ghost"
        color="neutral"
        @click="scan"
      />
    </div>
    <AppLoadError
      v-if="cliError"
      title="Could not scan the runner"
      :description="cliError"
      :retry="scan"
    />
    <ul
      v-else-if="clis"
      :class="listClass"
    >
      <template
        v-for="cli in clis"
        :key="cli.id"
      >
        <slot :cli="cli" />
      </template>
    </ul>
    <UiSkeleton
      v-else
      :class="skeletonClass"
    />
  </section>
</template>
