<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from 'cn'

// One page column in the app shell: optional header, a scrolling body, footer.
// `data-slot="root"` is what the shell's scrolling rules select.
const props = defineProps<{ bodyClass?: HTMLAttributes['class'], class?: HTMLAttributes['class'] }>()
</script>

<template>
  <section
    data-slot="root"
    :class="cn('flex min-h-0 min-w-0 flex-1 flex-col lg:not-last:border-e', props.class)"
  >
    <slot name="header" />
    <slot>
      <div :class="cn('flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 sm:gap-6 sm:p-6', bodyClass)">
        <slot name="body" />
      </div>
    </slot>
    <slot name="footer" />
  </section>
</template>
