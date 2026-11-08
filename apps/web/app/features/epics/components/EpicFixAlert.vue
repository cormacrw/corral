<script setup lang="ts">
import { runPath } from '~/utils/routes'
import type { EpicSync } from '@corral/contracts'
import { EPIC_FIX } from '~/utils/labels'

// Who is fixing an epic and why, on its page and flyout. There's no task for
// this work (D29), so this is the only place it's told.
defineProps<{ sync: Extract<EpicSync, { state: 'fixing' }> }>()
</script>

<template>
  <div
    class="rounded-lg bg-info/10 p-3 text-sm ring ring-inset ring-info/25"
    data-testid="epic-fix"
  >
    <p class="font-medium text-info">
      {{ EPIC_FIX[sync.fix].active }}
    </p>
    <p class="mt-1">
      <NuxtLink
        v-if="sync.developer"
        :to="runPath(sync.developer.name, sync.developer.runId)"
        class="font-medium text-brand hover:underline"
      >
        {{ sync.developer.name }} · run #{{ sync.developer.runNumber }}
      </NuxtLink>
      <span
        v-else
        class="text-muted-foreground"
      >Waiting for a developer</span>
    </p>
    <p class="mt-1 whitespace-pre-line break-words text-muted-foreground">
      {{ sync.reason }}
    </p>
    <p
      v-if="sync.files.length"
      class="mt-1 break-all font-mono text-xs text-muted-foreground"
    >
      {{ sync.files.join(', ') }}
    </p>
    <p
      v-if="sync.attempts"
      class="mt-1 text-xs text-muted-foreground"
    >
      {{ sync.attempts }} earlier {{ sync.attempts === 1 ? 'attempt' : 'attempts' }} came to nothing
    </p>
  </div>
</template>
