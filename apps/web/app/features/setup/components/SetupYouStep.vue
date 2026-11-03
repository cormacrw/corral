<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'
import { initials } from '~/utils/labels'

const props = defineProps<{ setup: Setup }>()
const { userName } = props.setup
const { isMobile } = useDevice()
</script>

<template>
  <div class="flex flex-col gap-4">
    <AppFormField
      v-slot="{ id }"
      label="Your name"
      required
    >
      <AppInput
        :id="id"
        v-model="userName"
        :size="isMobile ? 'xl' : 'lg'"
        icon="i-hugeicons-user"
        placeholder="Your name"
        :maxlength="80"
      />
    </AppFormField>
    <div :class="['flex items-center gap-3 text-sm text-muted-foreground', isMobile && 'rounded-md border border-border bg-muted/50 p-3']">
      <AppAvatar
        :text="initials(userName || 'You')"
        size="lg"
      />
      How you'll appear on comments, approvals and PM questions
    </div>
  </div>
</template>
