<script setup lang="ts">
import { SECTIONS, settingsSection } from '~/utils/routes'

// The Settings frame around every section: the section menu on desktop, a
// page header on mobile, which List, Agents and Runners replace with their own
// edge-to-edge layouts.
const route = useRoute()
const { isMobile } = useDevice()
const fullBleed = computed(() => {
  const path = route.path.replace(/\/$/, '')
  return isMobile.value && (path === SECTIONS.settings.to || Boolean(settingsSection(path.split('/')[2])?.fullBleed))
})
</script>

<template>
  <AppPanel>
    <MobilePageHeader v-if="isMobile && !fullBleed" />
    <div :class="fullBleed ? '' : ['mx-auto flex w-full max-w-[1100px] gap-8 max-[800px]:flex-col', isMobile ? 'p-4' : 'p-6']">
      <SettingsNav v-if="!isMobile" />
      <div :class="fullBleed ? '' : 'flex min-w-0 max-w-[880px] flex-1 flex-col gap-6'">
        <slot />
      </div>
    </div>
  </AppPanel>
</template>
