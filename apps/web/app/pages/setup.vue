<script setup lang="ts">
// Onboarding (design/onboarding.md): You → Repository → Agents → Names.
// With ?add=1 it's the add-project flow from the sidebar (repository only).
// Setup keeps the bare layout on mobile too, so it has no tab bar.
definePageMeta({ layout: 'bare' })
useSeoMeta({ title: 'Set up Corral' })
const { isMobile } = useDevice()
const setup = useSetup()
</script>

<template>
  <SetupMobile
    v-if="isMobile"
    :setup="setup"
  />
  <SetupDesktop
    v-else
    :setup="setup"
  />
</template>
