<script setup lang="ts">
defineProps<{ screenshots: { url: string, fileName: string }[], mobile?: boolean }>()
</script>

<template>
  <div>
    <h4 class="mb-1 text-xs font-medium text-muted-foreground">
      Screenshots
    </h4>
    <ul :class="['grid gap-2', mobile ? 'grid-cols-2' : 'grid-cols-3']">
      <li
        v-for="shot in screenshots"
        :key="shot.url"
      >
        <a
          :href="shot.url"
          target="_blank"
          rel="noopener"
          class="block overflow-hidden rounded-md border border-border hover:ring-2 hover:ring-primary"
        >
          <img
            :src="shot.url"
            :alt="shot.fileName"
            loading="lazy"
            class="aspect-video w-full bg-muted/50 object-cover object-top"
          >
          <span class="block truncate px-2 py-1 text-xs text-muted-foreground">{{ shot.fileName }}</span>
        </a>
      </li>
    </ul>
  </div>
</template>
