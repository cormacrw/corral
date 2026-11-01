<script setup lang="ts">
import { inject } from 'vue'
import { RouterLink } from 'vue-router'
import { FLYOUT_SHEETS, useTaskFlyout } from '~/composables/useTaskFlyout'
import { taskFlyoutHosts } from '~/composables/taskLinkHost'

const props = defineProps<{ taskRef: string }>()
const flyout = useTaskFlyout()
const sheets = inject(FLYOUT_SHEETS, false)
const device = useDevice()

function click(event: MouseEvent, navigate: (event: MouseEvent) => unknown) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (device.isMobile.value ? sheets : taskFlyoutHosts.value > 0) {
    event.preventDefault()
    flyout.open(props.taskRef)
  } else navigate(event)
}
</script>

<template>
  <RouterLink
    v-slot="{ href, navigate }"
    :to="`/tasks/${taskRef}`"
    custom
  >
    <a
      :href="href"
      class="text-primary hover:underline"
      @click="click($event, navigate)"
    ><slot>{{ taskRef }}</slot></a>
  </RouterLink>
</template>
