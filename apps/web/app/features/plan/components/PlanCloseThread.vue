<script setup lang="ts">
import { planPath } from '~/utils/routes'
import { errorMessage } from '~/lib/errors'
import type { PlanSession } from '@corral/contracts'
import { useMutation } from '@tanstack/vue-query'
import { closePlanThread } from '~/queries/plan'
import { usePlanRunner } from '~/features/plan/composables/usePlanRunner'

const props = defineProps<{ session: PlanSession, menu?: boolean }>()
const { pm } = usePlanRunner()
const device = useDevice()
const route = useRoute()
const router = useRouter()
const threads = usePlanThreads()
const toast = useToast()
const open = ref(false)
const closing = useMutation(closePlanThread)
const busy = ref(false)
const AppDrawer = resolveComponent('AppDrawer')
const AppModal = resolveComponent('AppModal')

async function close() {
  if (busy.value) return
  busy.value = true
  try {
    await closing.mutateAsync(props.session.id)
    threads.remove(props.session.id)
    open.value = false
    if (route.params.sessionId === props.session.id) await router.push(planPath())
  } catch (e) {
    toast.add({ title: 'Could not close thread', description: errorMessage(e), color: 'error' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <template v-if="!session.closed">
    <AppDropdownMenu
      v-if="menu"
      :items="[{ label: 'Close thread', icon: 'i-hugeicons-cancel-01', color: 'error', onSelect: () => { open = true } }]"
    >
      <AppButton
        icon="i-hugeicons-more-horizontal"
        variant="ghost"
        color="neutral"
        :aria-label="`Thread menu: ${session.title}`"
      />
    </AppDropdownMenu>
    <AppButton
      v-else
      label="Close thread"
      variant="ghost"
      color="neutral"
      size="sm"
      @click="open = true"
    />
    <component
      :is="device.isMobile.value ? AppDrawer : AppModal"
      v-model:open="open"
      title="Close this thread?"
      :description="`This discards the thread’s Draft tasks and unapproved plan and stops any running ${pm?.name ?? 'PM'} turn. Tasks already on the board or in the Backlog are kept.`"
      :dismissible="!busy"
    >
      <template #body>
        <div class="flex justify-end gap-2 pb-[env(safe-area-inset-bottom)]">
          <AppButton
            label="Cancel"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="open = false"
          />
          <AppButton
            label="Close thread"
            color="error"
            :loading="busy"
            @click="close"
          />
        </div>
      </template>
    </component>
  </template>
</template>
