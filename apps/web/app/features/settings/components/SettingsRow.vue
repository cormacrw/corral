<script setup lang="ts">
// A tappable row that opens something: a link with `to`, otherwise a button.
// `dense` fits the desktop section menu.
defineProps<{ to?: string, icon: string, label: string, description?: string, dense?: boolean }>()
const NuxtLink = resolveComponent('NuxtLink')
</script>

<template>
  <component
    :is="to ? NuxtLink : 'button'"
    :to="to"
    :type="to ? undefined : 'button'"
    :class="['flex w-full items-center gap-3 text-start', dense ? 'rounded-md px-2.5 py-1.5 hover:bg-muted/50' : 'min-h-14 px-4 py-3']"
  >
    <Icon
      :name="icon"
      class="size-5 shrink-0 text-muted-foreground"
    />
    <span class="min-w-0 flex-1">
      <span :class="['block text-foreground', dense && 'text-sm']">{{ label }}</span>
      <span
        v-if="description"
        class="block truncate text-xs text-muted-foreground"
      >{{ description }}</span>
    </span>
    <slot name="trailing" />
    <Icon
      name="i-hugeicons-arrow-right-01"
      class="size-4 shrink-0 text-muted-foreground/70"
    />
  </component>
</template>
