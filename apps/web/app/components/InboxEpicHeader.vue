<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'

// The top of an epic Inbox item: what it is, the epic and its PR
defineProps<{ badge: string, color: BadgeProps['color'], title: string, epicId: string, prUrl: string, prLabel: string }>()
</script>

<template>
  <header class="flex flex-wrap items-start justify-between gap-3 border-b border-default p-4">
    <div class="min-w-0 flex-1 basis-64">
      <UBadge
        :label="badge"
        :color="color"
        variant="subtle"
      />
      <h1 class="mt-2 text-lg font-semibold break-words">
        <NuxtLink
          :to="`/epics/${epicId}`"
          class="hover:underline"
        >{{ title }}</NuxtLink>
      </h1>
      <p class="text-xs text-muted">
        <slot />
      </p>
    </div>
    <UButton
      :to="prUrl"
      target="_blank"
      :label="prLabel"
      icon="i-lucide-git-pull-request"
      color="neutral"
      variant="outline"
      class="justify-center max-sm:min-h-11 max-sm:w-full"
    />
  </header>
</template>
