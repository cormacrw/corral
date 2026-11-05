<script setup lang="ts">
import type { Evidence } from '@corral/contracts'
import AppBadge from '~/components/app/AppBadge.vue'
import EvidenceGroup from '~/features/evidence/components/EvidenceGroup.vue'
import type { EvidenceGroupRounds } from '~/features/evidence/utils/evidenceRounds'

// One criterion's evidence: the current submission's, then earlier rounds
// behind a closed toggle (.corral/wiki/evidence-rounds.md)
defineProps<{ rounds: EvidenceGroupRounds }>()
const expanded = defineModel<boolean>('expanded', { default: false })
const emit = defineEmits<{ open: [item: Evidence] }>()
</script>

<template>
  <AppBadge
    v-if="rounds.carriedFrom !== null"
    :label="`From round ${rounds.carriedFrom + 1}`"
    color="neutral"
    variant="soft"
    size="sm"
    class="mt-2"
    data-testid="evidence-carried-from"
  />
  <EvidenceGroup
    :evidence="rounds.current"
    @open="emit('open', $event)"
  />
  <details
    v-if="rounds.earlierCount > 0"
    :open="expanded"
    class="mt-2"
    data-testid="evidence-earlier"
    @toggle="expanded = ($event.target as HTMLDetailsElement).open"
  >
    <summary class="tap-target flex cursor-pointer items-center rounded-md text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary">
      Earlier rounds ({{ rounds.earlierCount }})
    </summary>
    <div
      v-for="round in rounds.earlier"
      :key="round.round"
      class="mt-2 border-s-2 border-border ps-2 opacity-60"
      data-testid="evidence-earlier-round"
    >
      <p class="text-xs font-medium text-muted-foreground">
        Round {{ round.round + 1 }}
      </p>
      <EvidenceGroup
        :evidence="round.items"
        @open="emit('open', $event)"
      />
    </div>
  </details>
</template>
