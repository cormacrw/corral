<script setup lang="ts">
import { computed } from 'vue'
import type { Plan } from '@corral/contracts'
import { plural } from '~/utils/labels'
import { currentTasks } from '~/features/plan/utils/plan-versions'

// Opens the plan sheet on phones. A reserved row outside the log keeps the
// pill clear of answers and the composer.
const props = defineProps<{ plan: Plan }>()
const emit = defineEmits<{ open: [] }>()
const tasks = computed(() => plural(currentTasks(props.plan).length, 'task'))
</script>

<template>
  <div class="flex shrink-0 justify-center px-3 py-2">
    <AppButton
      icon="i-ri-list-check-2"
      :color="plan.status === 'proposed' ? 'primary' : 'neutral'"
      variant="subtle"
      class="min-h-11 max-w-full rounded-full px-4 shadow-sm"
      data-testid="plan-pill"
      @click="emit('open')"
    >
      <span>Plan v{{ plan.version }} · {{ tasks }}</span>
      <span
        v-if="plan.status === 'proposed'"
        class="text-xs"
      >Needs approval</span>
    </AppButton>
  </div>
</template>
