<script setup lang="ts">
import { parseOverride } from '~/utils/device'

const ITEMS = [{ label: 'Auto', value: 'auto' }, { label: 'Desktop', value: 'desktop' }, { label: 'Mobile', value: 'mobile' }]
const device = useDevice()
</script>

<template>
  <AppTabs
    :model-value="device.override.value"
    :items="ITEMS"
    :content="false"
    aria-label="Layout"
    data-testid="layout-override"
    @update:model-value="device.setOverride(parseOverride($event))"
  />
</template>
