<script setup lang="ts">
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
    <UiSidebarMenuBadge
      v-if="badge"
      :aria-label="badgeLabel"
      class="bg-primary text-primary-foreground"
    >
      {{ badge }}
    </UiSidebarMenuBadge>
  </UiSidebarMenuItem>
</template>
