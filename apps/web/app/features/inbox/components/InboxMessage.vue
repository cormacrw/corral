<script setup lang="ts">
defineProps<{
  item: { message?: string, body: string }
  // Up top in the panel: a clamped message, with the body in its own tab
  summary?: boolean
}>()
</script>

<template>
  <section
    v-if="item.message"
    aria-label="Message"
    class="min-w-0 space-y-3"
  >
    <p :class="['[overflow-wrap:anywhere]', summary ? 'line-clamp-3 text-sm' : 'text-base whitespace-pre-wrap']">
      <TaskRefText :text="item.message" />
    </p>
    <details
      v-if="item.body && !summary"
      class="min-w-0"
    >
      <summary class="min-h-11 cursor-pointer content-center rounded-md text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary">
        Full message
      </summary>
      <MarkdownText :text="item.body" />
    </details>
  </section>
  <MarkdownText
    v-else
    :text="item.body"
  />
</template>
