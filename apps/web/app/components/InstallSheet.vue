<script setup lang="ts">
// The Install screen (design/mobile.md, "Install Corral" frame): a bottom
// sheet on mobile, a modal on the web. Chrome gets its install prompt
// behind one button; iOS, which has no prompt, gets the Add to Home Screen
// steps. Settings opens it while useInstall() says it can install.
const { mode, open, install } = useInstall()
const device = useDevice()

const UDrawer = resolveComponent('UDrawer')
const UModal = resolveComponent('UModal')

// Nothing to offer once installed, or if the prompt went away
watch(mode, (next) => {
  if (!next) open.value = false
})
</script>

<template>
  <component
    :is="device.isMobile.value ? UDrawer : UModal"
    v-model:open="open"
    title="Install Corral"
    description="Opens full screen from your home screen, like an app."
    :ui="device.isMobile.value
      ? { overlay: 'bg-slate-900/45', content: 'max-h-[88%] rounded-t-2xl shadow-[0_-8px_30px_rgb(0_0_0/0.15)] ring-0', handle: 'mt-2! mb-1! h-1.25! w-9!' }
      : { content: 'max-w-sm' }"
  >
    <template #content>
      <div
        class="overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
        data-testid="install-sheet"
      >
        <div class="flex justify-end ps-4 pe-1">
          <UButton
            icon="i-lucide-x"
            variant="ghost"
            color="neutral"
            size="lg"
            aria-label="Close"
            class="size-11 justify-center text-muted"
            @click="open = false"
          />
        </div>
        <div
          class="flex flex-col items-center gap-4 px-4 pb-2 text-center"
          aria-hidden="true"
        >
          <span class="flex size-16 items-center justify-center rounded-[14px] bg-primary text-inverted">
            <UIcon
              name="i-lucide-fence"
              class="size-9"
            />
          </span>
          <div class="flex flex-col gap-1">
            <h2 class="text-[22px] leading-7 font-semibold text-highlighted">
              Install Corral
            </h2>
            <p class="text-[13px] leading-[18px] text-muted">
              Opens full screen from your home screen, like an app.
            </p>
          </div>
        </div>

        <div
          v-if="mode === 'ios'"
          class="flex flex-col gap-3 px-4 py-3"
        >
          <span class="text-xs font-semibold text-muted">On iPhone (Safari)</span>
          <ol class="flex flex-col gap-3">
            <li class="flex items-center gap-3 text-highlighted">
              <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[13px] font-semibold text-highlighted">1</span>
              <span>Tap <UIcon
                name="i-lucide-share"
                class="size-4 align-[-3px]"
                aria-label="Share"
                role="img"
              /> Share in the toolbar</span>
            </li>
            <li class="flex items-center gap-3 text-highlighted">
              <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[13px] font-semibold text-highlighted">2</span>
              <span>Choose <span class="font-medium">Add to Home Screen</span></span>
            </li>
            <li class="flex items-center gap-3 text-highlighted">
              <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[13px] font-semibold text-highlighted">3</span>
              <span>Tap <span class="font-medium">Add</span></span>
            </li>
          </ol>
        </div>

        <div
          v-else-if="mode === 'prompt'"
          class="flex flex-col gap-2 px-4 py-3"
        >
          <span class="text-xs font-semibold text-muted">On Android (Chrome)</span>
          <UButton
            icon="i-lucide-square-plus"
            label="Install app"
            size="xl"
            block
            :ui="{ leadingIcon: 'size-4' }"
            data-testid="install-app"
            @click="install"
          />
        </div>

        <p class="px-4 pt-1 pb-7.5 text-xs text-muted">
          You’ll sign in to Cloudflare Access once in the installed app. Corral itself is served from your home server.
        </p>
      </div>
    </template>
  </component>
</template>
