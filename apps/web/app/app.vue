<script setup lang="ts">
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }
  ],
  link: [
    // Relative in the prototype, which runs from a sub-path
    { rel: 'icon', href: import.meta.prototype ? 'favicon.ico' : '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'en'
  }
})

useSeoMeta({
  title: 'Corral'
})

// One live connection for the whole app (design/app-shell.md)
const live = useLive()
onMounted(() => {
  void live.load()
  live.connect()
})

// Mobile or web at the root (D17, design/mobile.md). URLs are the same in
// both; mobile only swaps the shell. Pages that opt out of the shell
// (onboarding's bare layout) keep their own.
const device = useDevice()
const route = useRoute()
const layout = computed(() => device.isMobile.value && route.meta.layout === undefined ? 'mobile' : undefined)
</script>

<template>
  <UApp>
    <NuxtLayout :name="layout">
      <NuxtPage />
    </NuxtLayout>
    <InstallSheet />
  </UApp>
</template>
