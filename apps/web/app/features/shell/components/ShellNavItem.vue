<script setup lang="ts">
import AppBadge from '~/components/app/AppBadge.vue'

defineProps<{ to: string, label: string, icon: string, active?: boolean, badge?: number, badgeLabel?: string }>()
</script>

<template>
  <UiSidebarMenuItem>
    <UiSidebarMenuButton
      as-child
      :tooltip="label"
      :is-active="active"
    >
      <NuxtLink
        :to="to"
        :aria-current="active ? 'page' : undefined"
      >
        <Icon :name="icon" />
        <span>{{ label }}</span>
      </NuxtLink>
    </UiSidebarMenuButton>
    <!-- shadcn's Badge, where the sidebar puts its menu badge -->
    <AppBadge
      v-if="badge"
      :label="badge"
      size="sm"
      :aria-label="badgeLabel"
      class="pointer-events-none absolute top-1.5 right-1 tabular-nums group-data-[collapsible=icon]:hidden"
    />
  </UiSidebarMenuItem>
</template>
