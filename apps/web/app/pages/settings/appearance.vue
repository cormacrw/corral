<script setup lang="ts">
import { parseOverride } from '~/utils/device'

const colorMode = useColorMode()
const device = useDevice()
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-medium">
        Appearance
      </h2>
    </template>
    <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
      <div>
        <span class="font-medium">Colour mode</span>
        <p class="text-xs text-muted">
          Primary colour, light palette and font are configured in app.config.ts and main.css.
        </p>
      </div>
      <UTabs
        :model-value="colorMode.preference"
        :items="[{ label: 'System', value: 'system' }, { label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }]"
        size="sm"
        :content="false"
        @update:model-value="colorMode.preference = String($event)"
      />
    </div>
    <div class="mt-5 grid gap-2 sm:grid-cols-[1fr_320px]">
      <div>
        <span class="font-medium">Dark background</span>
        <p class="text-xs text-muted">
          Background, surfaces and borders in dark mode. Saved for this device only.
        </p>
      </div>
      <DarkNeutralPicker />
    </div>
    <div class="mt-5 grid gap-2 sm:grid-cols-[1fr_320px]">
      <div>
        <span class="font-medium">Layout</span>
        <p class="text-xs text-muted">
          Auto uses the mobile layout on a phone or the installed app. Saved for this device only.
        </p>
      </div>
      <UTabs
        :model-value="device.override.value"
        :items="[{ label: 'Auto', value: 'auto' }, { label: 'Desktop', value: 'desktop' }, { label: 'Mobile', value: 'mobile' }]"
        size="sm"
        :content="false"
        data-testid="layout-override"
        @update:model-value="device.setOverride(parseOverride($event))"
      />
    </div>
  </UCard>
</template>
