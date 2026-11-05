<script setup lang="ts">
import { computed } from 'vue'

// Links to the thread that started this one and those it started
const props = defineProps<{ sessionId: string, parentSessionId?: string | null }>()
const shell = useShell()
const parent = computed(() => shell.planSessions.find(s => s.id === props.parentSessionId))
const children = computed(() => shell.planSessions.filter(s => s.parentSessionId === props.sessionId))
</script>

<template>
  <nav
    v-if="parent || children.length"
    aria-label="Related threads"
    class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2 text-sm"
  >
    <NuxtLink
      v-if="parent"
      :to="`/plan/${parent.id}`"
      class="text-brand hover:underline"
    >Started from: {{ parent.title }}</NuxtLink>
    <span
      v-if="children.length"
      class="text-muted-foreground"
    >Child threads:</span>
    <NuxtLink
      v-for="child in children"
      :key="child.id"
      :to="`/plan/${child.id}`"
      class="text-brand hover:underline"
    >{{ child.title }}{{ child.closed ? ' (closed)' : '' }}</NuxtLink>
  </nav>
</template>
