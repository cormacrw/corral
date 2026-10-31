<script setup lang="ts">
import type { InboxPanel } from '~/composables/useInboxPanel'

// The verdict in plain text and icons: the reviewer's verdict, the gate checks
// and how many criteria are met. Human checks aren't met yet, but aren't unmet.
const props = defineProps<{ p: InboxPanel }>()
const review = computed(() => props.p.latestReview.value)
const reviewer = computed(() => props.p.task.value?.reviewer?.name ?? 'Reviewer')
const allMet = computed(() => props.p.met.value === props.p.criteria.value.length)
const unmet = computed(() => props.p.criteria.value.some(c => c.met === false))
</script>

<template>
  <div
    v-if="p.hasVerdict.value"
    class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted"
    data-testid="inbox-verdict"
  >
    <span
      v-if="review"
      class="flex items-center gap-1.5"
    >
      <UIcon
        :name="review.verdict === 'approved' ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
        :class="['size-4 shrink-0', review.verdict === 'approved' ? 'text-success' : 'text-warning']"
      />
      <span><span class="font-medium text-default">{{ reviewer }}</span> {{ review.verdict === 'approved' ? 'approved' : 'requested changes' }} · round {{ review.round + 1 }}</span>
    </span>
    <span
      v-if="p.gates.value.length"
      class="flex items-center gap-1.5"
    >
      <UIcon
        name="i-lucide-circle-check"
        class="size-4 shrink-0 text-success"
      />
      <span>{{ p.gates.value.map(g => g.name).join(', ') }} passed</span>
    </span>
    <span
      v-if="p.criteria.value.length"
      class="flex items-center gap-1.5"
    >
      <UIcon
        :name="unmet ? 'i-lucide-list-x' : 'i-lucide-list-checks'"
        :class="['size-4 shrink-0', unmet ? 'text-error' : allMet ? 'text-success' : 'text-muted']"
      />
      <span><span :class="['font-medium', unmet ? 'text-error' : 'text-default']">{{ p.met.value }} of {{ p.criteria.value.length }}</span> criteria met</span>
    </span>
  </div>
</template>
