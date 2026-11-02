<script setup lang="ts">
import type { EpicFixRun } from '@corral/contracts'
import { EPIC_FIX, epicFixResult, runPath } from '~/utils/labels'

// The developer runs this epic has had, newest first (D29)
defineProps<{ runs: EpicFixRun[] }>()
</script>

<template>
  <section>
    <h3 class="mb-1 text-xs font-medium text-muted">
      Past fixes
    </h3>
    <ol
      class="flex flex-col gap-2 text-xs"
      data-testid="epic-fix-runs"
    >
      <li
        v-for="run in runs"
        :key="run.runId"
        class="rounded-md border border-default p-2"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-x-2">
          <span class="font-medium text-highlighted">{{ EPIC_FIX[run.fix].past }}</span>
          <NuxtLink
            :to="runPath(run.developer, run.runId)"
            class="text-primary hover:underline"
          >
            {{ run.developer }} · run #{{ run.runNumber }}
          </NuxtLink>
        </div>
        <p
          v-if="run.reason"
          class="mt-1 line-clamp-3 whitespace-pre-line break-words text-muted"
        >
          {{ run.reason }}
        </p>
        <p
          v-if="run.summary"
          class="mt-1 line-clamp-3 break-words"
        >
          {{ run.summary }}
        </p>
        <p class="mt-1 font-medium text-muted">
          {{ epicFixResult(run).join(' · ') }}
        </p>
      </li>
    </ol>
  </section>
</template>
