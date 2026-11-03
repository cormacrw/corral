<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'

const props = defineProps<{ setup: Setup }>()
const { clis, cliError, scan, cliDetail } = props.setup
const { isMobile } = useDevice()
const found = computed(() => clis.value?.filter(c => c.version).length ?? 0)
const badgeSize = computed(() => isMobile.value ? 'sm' : 'xs')
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-2">
      <div>
        <p class="font-medium">
          Detected in the runner
        </p>
        <p class="text-xs text-muted-foreground">
          {{ found }} of 3 supported CLIs found
        </p>
      </div>
      <AppButton
        label="Scan again"
        :size="isMobile ? 'md' : 'xs'"
        variant="ghost"
        color="neutral"
        icon="i-ri-refresh-line"
        @click="scan"
      />
    </div>
    <AppLoadError
      v-if="cliError"
      title="Could not scan the runner"
      :description="cliError"
      :retry="scan"
    />
    <UiSkeleton
      v-else-if="!clis"
      class="h-20 w-full"
    />
    <ul :class="['flex flex-col', isMobile ? 'gap-3' : 'gap-2']">
      <li
        v-for="cli in clis ?? []"
        :key="cli.id"
        :class="['flex items-start gap-3 rounded-lg border p-3 text-sm', isMobile && cli.signedIn ? 'border-primary bg-primary/10' : 'border-border']"
      >
        <AppCheckbox
          :model-value="cli.signedIn"
          disabled
          :aria-label="cli.name"
          class="mt-0.5"
        />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ cli.name }}</span>
            <AppBadge
              :label="cli.signedIn ? 'Ready' : cli.version ? 'Not signed in' : 'Not found'"
              :color="cli.signedIn ? 'success' : 'warning'"
              variant="subtle"
              :size="badgeSize"
            />
          </div>
          <p class="mt-1 text-xs break-words text-muted-foreground">
            {{ cliDetail(cli) }}
          </p>
        </div>
      </li>
      <li class="flex items-start gap-3 rounded-lg border border-border p-3 text-sm opacity-60">
        <AppCheckbox
          :model-value="false"
          disabled
          aria-label="Gemini CLI"
          class="mt-0.5"
        />
        <div class="flex-1">
          <div class="flex items-center gap-2">
            <span class="font-medium">Gemini CLI</span>
            <AppBadge
              label="Coming later"
              color="neutral"
              variant="subtle"
              :size="badgeSize"
            />
          </div>
          <p class="mt-1 text-xs text-muted-foreground">
            not found
          </p>
        </div>
      </li>
    </ul>
    <AppAlert
      color="info"
      variant="subtle"
      icon="i-ri-shield-line"
      title="Your credentials stay with your CLI. Corral never sees, stores or sends your model-provider login."
    />
  </div>
</template>
