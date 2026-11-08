<script setup lang="ts">
// The Install screen (design/mobile.md, "Install Corral" frame): a bottom
// sheet on mobile, a modal on the web. Chrome gets its install prompt
// behind one button; iOS, which has no prompt, gets the Add to Home Screen
// steps. Settings opens it while useInstall() says it can install.
const { mode, open, install } = useInstall()
const device = useDevice()

const AppDrawer = resolveComponent('AppDrawer')
const AppModal = resolveComponent('AppModal')
// Each takes its content in a different slot
const slot = computed(() => device.isMobile.value ? 'content' : 'body')

// Nothing to offer once installed, or if the prompt went away
watch(mode, (next) => {
  if (!next) open.value = false
})
</script>

<template>
  <component
    :is="device.isMobile.value ? AppDrawer : AppModal"
    v-model:open="open"
    title="Install Corral"
    description="Opens full screen from your home screen, like an app."
    :content-class="device.isMobile.value ? 'data-[swipe-direction=down]:max-h-[88%] data-[swipe-direction=down]:rounded-t-2xl shadow-[0_-8px_30px_rgb(0_0_0/0.15)]' : 'sm:max-w-sm'"
  >
    <template #[slot]>
      <div
        class="overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
        data-testid="install-sheet"
      >
        <!-- AppModal brings its own title and close button -->
        <template v-if="device.isMobile.value">
          <div class="flex justify-end ps-4 pe-1">
            <AppButton
              icon="i-hugeicons-cancel-01"
              variant="ghost"
              color="neutral"
              size="lg"
              aria-label="Close"
              class="size-11 justify-center text-muted-foreground"
              @click="open = false"
            />
          </div>
          <div
            class="flex flex-col items-center gap-4 px-4 pb-2 text-center"
            aria-hidden="true"
          >
            <span class="flex size-16 items-center justify-center rounded-[14px] bg-primary text-background">
              <Icon
                name="i-hugeicons-shield-energy"
                class="size-9"
              />
            </span>
            <div class="flex flex-col gap-1">
              <h2 class="text-[22px] leading-7 font-semibold text-foreground">
                Install Corral
              </h2>
              <p class="text-[13px] leading-[18px] text-muted-foreground">
                Opens full screen from your home screen, like an app.
              </p>
            </div>
          </div>
        </template>

        <div
          v-if="mode === 'ios'"
          class="flex flex-col gap-3 px-4 py-3"
        >
          <span class="text-xs font-semibold text-muted-foreground">On iPhone (Safari)</span>
          <ol class="flex flex-col gap-3">
            <li class="flex items-center gap-3 text-foreground">
              <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-semibold text-foreground">1</span>
              <span>Tap <Icon
                name="i-hugeicons-share-04"
                class="size-4 align-[-3px]"
                aria-label="Share"
                role="img"
              /> Share in the toolbar</span>
            </li>
            <li class="flex items-center gap-3 text-foreground">
              <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-semibold text-foreground">2</span>
              <span>Choose <span class="font-medium">Add to Home Screen</span></span>
            </li>
            <li class="flex items-center gap-3 text-foreground">
              <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-semibold text-foreground">3</span>
              <span>Tap <span class="font-medium">Add</span></span>
            </li>
          </ol>
        </div>

        <div
          v-else-if="mode === 'prompt'"
          class="flex flex-col gap-2 px-4 py-3"
        >
          <span class="text-xs font-semibold text-muted-foreground">On Android (Chrome)</span>
          <AppButton
            icon="i-hugeicons-add-square"
            label="Install app"
            size="xl"
            block
            data-testid="install-app"
            @click="install"
          />
        </div>

        <p class="px-4 pt-1 pb-7.5 text-xs text-muted-foreground">
          You’ll sign in to Cloudflare Access once in the installed app. Corral itself is served from your home server.
        </p>
      </div>
    </template>
  </component>
</template>
