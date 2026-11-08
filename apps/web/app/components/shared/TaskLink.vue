<script setup lang="ts">
import { taskPath } from '~/utils/routes'
import { RouterLink } from 'vue-router'
import { useFlyoutHost, useTaskFlyout } from '~/composables/useTaskFlyout'

const props = defineProps<{ taskRef: string }>()
const flyout = useTaskFlyout()
const host = useFlyoutHost()
const device = useDevice()

function click(event: MouseEvent, navigate: (event: MouseEvent) => unknown) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (device.isMobile.value ? host.sheets : host.docked()) {
    event.preventDefault()
    flyout.open(props.taskRef)
  } else navigate(event)
}
</script>

<template>
  <RouterLink
    v-slot="{ href, navigate }"
    :to="taskPath(taskRef)"
    custom
  >
    <a
      :href="href"
      class="text-brand hover:underline"
      @click="click($event, navigate)"
    ><slot>{{ taskRef }}</slot></a>
  </RouterLink>
</template>
