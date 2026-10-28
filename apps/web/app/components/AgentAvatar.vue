<script setup lang="ts">
import { initials } from '~/utils/labels'

// An agent's avatar, or the human's ("You"), with the working status dot
// (shared working indicator). Shows their profile picture when they have
// one and initials otherwise; `src` overrides the lookup (e.g. a preview).
const props = withDefaults(defineProps<{
  name: string
  working?: boolean
  size?: '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '3xl'
  src?: string | null
}>(), { working: false, size: 'sm', src: undefined })
const live = useLive()
const picture = computed(() => {
  if (props.src !== undefined) return props.src ?? undefined
  if (props.name === 'You') return live.state.value.profile?.avatarUrl ?? undefined
  return live.state.value.agents.find(a => a.name.toLowerCase() === props.name.toLowerCase())?.avatarUrl ?? undefined
})
</script>

<template>
  <span class="relative inline-flex shrink-0">
    <UAvatar
      :src="picture"
      :text="initials(props.name)"
      :size="props.size"
      :alt="props.name"
    />
    <span
      v-if="props.working"
      class="absolute -end-0.5 -bottom-0.5 flex size-2.5"
      aria-hidden="true"
    >
      <span class="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75 motion-reduce:hidden" />
      <span class="relative inline-flex size-2.5 rounded-full border border-default bg-success" />
    </span>
  </span>
</template>
