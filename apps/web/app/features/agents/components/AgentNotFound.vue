<script setup lang="ts">
import { SECTIONS } from '~/utils/routes'
</script>

<template>
  <div
    class="flex flex-col items-center gap-3 p-12 text-center"
    data-testid="agent-not-found"
  >
    <h1 class="text-lg font-semibold text-foreground">
      Agent not found
    </h1>
    <p class="text-sm text-muted-foreground">
      It doesn't exist, or it was renamed.
    </p>
    <AppButton
      label="Home"
      :to="SECTIONS.home.to"
      color="neutral"
      variant="outline"
    />
  </div>
</template>
