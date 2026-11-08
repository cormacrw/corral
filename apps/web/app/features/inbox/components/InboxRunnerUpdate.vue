<script setup lang="ts">
import { settingsPath } from '~/utils/routes'
import type { RunnerUpdateItem } from '@corral/contracts'
import { useMutation } from '@tanstack/vue-query'
import { updateRunner } from '~/queries/system'

// A runner that can't update (COR-435). It leaves Needs you by itself once the
// runner comes back on the server's build.
defineProps<{ item: RunnerUpdateItem }>()
const retry = useMutation(updateRunner)
</script>

<template>
  <section
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    aria-label="Runner update"
    data-testid="inbox-runner-update"
  >
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
      <header class="space-y-1">
        <AppBadge
          label="Runner · Needs you"
          color="error"
          variant="subtle"
          size="sm"
        />
        <h1 class="text-lg font-semibold text-foreground">
          {{ item.subject }}
        </h1>
        <p class="font-mono text-xs text-muted-foreground">
          {{ item.commit.slice(0, 7) }} → {{ item.serverCommit.slice(0, 7) }}
        </p>
      </header>
      <AppAlert
        color="error"
        variant="subtle"
        title="Update error"
        :description="item.body"
      />
      <p class="text-sm text-muted-foreground">
        Fix the problem on the runner's host, then retry. Check <code>journalctl -u corral-runner-update</code> there.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <AppButton
          v-if="item.online"
          label="Retry update"
          size="sm"
          :loading="retry.isPending.value"
          @click="retry.mutate(item.runnerId)"
        />
        <AppButton
          label="Runner settings"
          size="sm"
          variant="outline"
          :to="settingsPath('runner')"
        />
      </div>
      <p
        v-if="retry.error.value"
        class="text-sm text-destructive"
      >
        {{ retry.error.value.message || 'Update request failed' }}
      </p>
    </div>
  </section>
</template>
