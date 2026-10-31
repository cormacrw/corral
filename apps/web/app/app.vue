<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { startShell } from '~/queries/shell'

useDarkNeutral()

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover' }
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
onUnmounted(startShell(useQueryClient()))
onMounted(() => live.connect())

// Safari on iOS ignores the viewport pinch restriction. Keep this in the
// app shell so navigation never adds more listeners; leave desktop gestures alone.
const preventGestureZoom = (event: Event) => event.preventDefault()
onMounted(() => {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (!isIOS) return
  document.addEventListener('gesturestart', preventGestureZoom, { passive: false })
  document.addEventListener('gesturechange', preventGestureZoom, { passive: false })
})
onUnmounted(() => {
  document.removeEventListener('gesturestart', preventGestureZoom)
  document.removeEventListener('gesturechange', preventGestureZoom)
})

// Mobile or web at the root (D17, design/mobile.md). URLs are the same in
// both; mobile only swaps the shell. Pages that opt out of the shell
// (onboarding's bare layout) keep their own.
const device = useDevice()
const route = useRoute()
const layout = computed(() => device.isMobile.value && route.meta.layout === undefined ? 'mobile' : undefined)
</script>

<template>
  <UApp :toaster="device.isMobile.value ? { position: 'top-center', ui: { viewport: 'top-[calc(env(safe-area-inset-top)+1rem)]' } } : undefined">
    <NuxtLayout :name="layout">
      <NuxtPage />
    </NuxtLayout>
    <InstallSheet />
  </UApp>
</template>
