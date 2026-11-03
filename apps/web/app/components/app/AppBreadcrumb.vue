<script setup lang="ts">
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '~/components/ui/breadcrumb'

defineProps<{ items: readonly { label: string, to?: string, icon?: string }[] }>()
</script>

<template>
  <Breadcrumb class="min-w-0">
    <BreadcrumbList>
      <template
        v-for="(item, index) in items"
        :key="index"
      >
        <BreadcrumbSeparator v-if="index > 0" />
        <BreadcrumbItem class="min-w-0">
          <BreadcrumbLink
            v-if="item.to"
            as-child
          >
            <NuxtLink
              :to="item.to"
              class="truncate"
            >{{ item.label }}</NuxtLink>
          </BreadcrumbLink>
          <BreadcrumbPage
            v-else
            class="truncate"
          >
            {{ item.label }}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </template>
    </BreadcrumbList>
  </Breadcrumb>
</template>
