<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { epicHistoryQuery } from '~/queries/epics'

// What's happened to the epic's branch and review
const props = defineProps<{ epicId: string }>()
const history = useQuery(computed(() => epicHistoryQuery(props.epicId)))
</script>

<template>
  <section v-if="history.data.value?.length">
    <h3 class="mb-1 text-xs font-medium text-muted-foreground">
      History
    </h3>
    <ol
      class="flex max-h-64 flex-col gap-1.5 overflow-y-auto text-xs"
      data-testid="epic-history"
    >
      <li
        v-for="entry in history.data.value"
        :key="entry.id"
      >
        <span
          v-if="!entry.text.startsWith('You ')"
          class="me-1 font-medium"
        >{{ entry.actor }}</span>
        <span class="text-muted-foreground">{{ entry.text }}</span>
      </li>
    </ol>
  </section>
</template>
