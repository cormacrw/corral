<script setup lang="ts">
// A mobile screen's own header (design/mobile.md). It replaces the mobile
// layout's default title row while mounted: an optional back button, an
// optional eyebrow line over the title, and the screen's actions in the slot.
// Only render it under the mobile layout, which holds the target.
const props = withDefaults(defineProps<{ title: string, eyebrow?: string, back?: string }>(), { eyebrow: undefined, back: undefined })

const owners = useState('mobile.pageHeaders', () => 0)
onMounted(() => {
  owners.value++
})
onBeforeUnmount(() => {
  owners.value--
})
</script>

<template>
  <Teleport
    defer
    to="#mobile-header"
  >
    <div class="flex h-14 items-center gap-2 px-4">
      <UButton
        v-if="props.back"
        :to="props.back"
        icon="i-lucide-arrow-left"
        variant="ghost"
        color="neutral"
        aria-label="Back"
        class="-ms-2"
      />
      <div class="min-w-0 flex-1">
        <p
          v-if="props.eyebrow"
          class="truncate text-xs text-muted"
        >
          {{ props.eyebrow }}
        </p>
        <h1 :class="['truncate font-semibold text-highlighted', props.eyebrow ? 'text-base leading-tight' : 'text-xl']">
          {{ props.title }}
        </h1>
      </div>
      <slot />
    </div>
  </Teleport>
</template>
