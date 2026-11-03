<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'

// Onboarding on the web (design/onboarding.md): a top bar, the stepper, and
// the step in a card with Back and Continue in its footer.
const props = defineProps<{ setup: Setup }>()
const { adding, steps, step, index, heading, subheading, back } = props.setup
</script>

<template>
  <div class="flex min-h-svh flex-col">
    <header class="flex h-16 items-center border-b border-border px-6">
      <SetupBrand />
    </header>
    <main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pt-12 pb-12">
      <AppStepper
        v-if="!adding"
        v-model="step"
        :items="steps"
        linear
        class="w-full"
      />
      <div>
        <h1 class="text-2xl font-semibold">
          {{ heading }}
        </h1>
        <p class="text-sm text-muted-foreground">
          {{ subheading }}
        </p>
      </div>

      <AppCard>
        <SetupSteps :setup="setup" />

        <template #footer>
          <div class="flex w-full items-center justify-between">
            <AppButton
              label="Back"
              variant="outline"
              color="neutral"
              :disabled="index === 0 || adding"
              @click="back"
            />
            <SetupContinueButton :setup="setup" />
          </div>
        </template>
      </AppCard>
    </main>
  </div>
</template>
