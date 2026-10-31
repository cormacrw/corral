<template>
  <div
    class="flex flex-col items-center gap-3 p-12 text-center"
    data-testid="agent-not-found"
  >
    <h1 class="text-lg font-semibold text-highlighted">
      Agent not found
    </h1>
    <p class="text-sm text-muted">
      It doesn't exist, or it was renamed.
    </p>
    <UButton
      label="Home"
      to="/home"
      color="neutral"
      variant="outline"
    />
  </div>
</template>
