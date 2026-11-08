<script setup lang="ts">
import { provideFlyoutHost } from '~/composables/useTaskFlyout'
import { shellTitle } from '~/utils/routes'

// The app shell (design/app-shell.md). The sidebar sits beside the page, under
// any status banner, rather than covering the viewport and hiding it.
const shell = useShell()
const route = useRoute()
const currentSlug = computed(() => typeof route.params.slug === 'string' ? route.params.slug : null)
// The one docked flyout for pages that set the taskFlyout meta, kept here so it
// lives through navigation. Inbox and Plan host their own: theirs fills its plan
// slot from page state, and the Inbox swaps it with the selected item.
const missing = useProjectMissing(currentSlug)
const flyoutHosted = computed(() => Boolean(route.meta.taskFlyout) && !missing.value)
provideFlyoutHost({ docked: () => flyoutHosted.value })
const searchOpen = ref(false)
// Below the sidebar's breakpoint it is an overlay, and this bar names the page
const title = computed(() => shellTitle(route.path, shell.projects, shell.agents))
</script>

<template>
  <div class="flex h-svh flex-col bg-background text-foreground">
    <ShellBanners />

    <UiSidebarProvider class="relative min-h-0 flex-1">
      <ShellSidebar @search="searchOpen = true" />

      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          class="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden"
          data-testid="shell-bar"
        >
          <UiSidebarTrigger />
          <h1 class="truncate text-sm font-semibold">
            {{ title }}
          </h1>
        </header>
        <!-- Panels whose content is in the default slot have no scroller of
             their own, so the panel is it. The glow around active runs stays
             clipped sideways. -->
        <div
          class="flex min-h-0 flex-1 max-[1100px]:flex-col [&>[data-slot=root]]:overflow-x-hidden [&>[data-slot=root]]:overflow-y-auto [&>[data-slot=root]]:overscroll-contain"
          data-testid="shell-page"
        >
          <slot />
          <TaskFlyout
            v-if="flyoutHosted"
            class="border-s-0!"
          />
        </div>
      </div>
    </UiSidebarProvider>

    <ShellSearch v-model:open="searchOpen" />
  </div>
</template>
