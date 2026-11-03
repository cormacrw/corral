<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'

// Onboarding on mobile (design/mobile.md, frames "Setup · Your name",
// "Repository", "Agent CLIs" and "Name agents"). The same steps and rules as
// the web page in one column, with a progress bar in place of the stepper and
// the step's action pinned to the bottom. It sits in the bare layout: no tab bar.
const props = defineProps<{ setup: Setup }>()
const { adding, steps, step, index, heading, back } = props.setup
</script>

<template>
  <div class="flex h-svh flex-col">
    <header class="shrink-0 border-b border-border pt-[env(safe-area-inset-top)]">
      <div class="flex min-h-14 items-center justify-between gap-2 px-4">
        <SetupBrand v-if="index === 0 && !adding" />
        <template v-else>
          <AppButton
            icon="i-ri-arrow-left-line"
            variant="ghost"
            color="neutral"
            aria-label="Back"
            @click="back"
          />
          <h1 class="min-w-0 flex-1 truncate text-lg font-semibold">
            {{ heading }}
          </h1>
        </template>
      </div>
    </header>

    <main class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pt-5 pb-6">
      <div
        v-if="!adding"
        class="flex flex-col gap-2"
      >
        <div
          class="flex gap-1.5"
          role="progressbar"
          aria-label="Setup progress"
          :aria-valuenow="index + 1"
          aria-valuemin="1"
          :aria-valuemax="steps.length"
        >
          <span
            v-for="(s, i) in steps"
            :key="s.value"
            :class="['h-1 flex-1 rounded-full', i <= index ? 'bg-primary' : 'bg-muted']"
          />
        </div>
        <p class="text-xs font-medium text-muted-foreground">
          Step {{ index + 1 }} of {{ steps.length }} · {{ steps[index]?.title }}
        </p>
      </div>

      <div v-if="step === 'you'">
        <h1 class="text-2xl font-semibold">
          What should agents call you?
        </h1>
        <p class="mt-1 text-muted-foreground">
          Used on comments, approvals and PM questions.
        </p>
      </div>
      <SetupSteps :setup="setup" />
      <p
        v-if="step === 'you'"
        class="text-xs text-muted-foreground"
      >
        Saved on this server, so every device sees it.
      </p>
    </main>

    <footer class="shrink-0 border-t border-border bg-background px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <SetupContinueButton
        :setup="setup"
        size="xl"
        block
      />
    </footer>
  </div>
</template>
