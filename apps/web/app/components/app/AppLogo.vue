<script setup lang="ts">
// The Corral app icon (assets/corral.webp). Imported, so the build hashes
// it and the prototype finds it from any sub-path. Size it with a class.
import icon from '~/assets/images/corral-icon.webp'
</script>

<template>
  <img
    :src="icon"
    alt=""
    aria-hidden="true"
    draggable="false"
    class="shrink-0 select-none"
  >
</template>
