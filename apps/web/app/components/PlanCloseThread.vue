<script setup lang="ts">
import type { PlanSession } from '@corral/contracts'
import { useMutation } from '@tanstack/vue-query'
import { closePlanThread } from '~/queries/plan'

const props = defineProps<{ session: PlanSession, menu?: boolean }>()
const shell = useShell()
const pmName = computed(() => shell.agents.find(a => a.role === 'pm')?.name ?? 'PM')
const device = useDevice()
const route = useRoute()
const router = useRouter()
const threads = usePlanThreads()
const toast = useToast()
const open = ref(false)
const closing = useMutation(closePlanThread)
const busy = ref(false)
const UDrawer = resolveComponent('UDrawer')
const UModal = resolveComponent('UModal')

async function close() {
  if (busy.value) return
  busy.value = true
  try {
    await closing.mutateAsync(props.session.id)
    threads.remove(props.session.id)
    open.value = false
    if (route.params.sessionId === props.session.id) await router.push('/plan')
  } catch (e) {
    toast.add({ title: 'Could not close thread', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <template v-if="!session.closed">
    <UDropdownMenu
      v-if="menu"
      :items="[{ label: 'Close thread', icon: 'i-lucide-x', color: 'error', onSelect: () => { open = true } }]"
    >
      <UButton
        icon="i-lucide-ellipsis"
        variant="ghost"
        color="neutral"
        :aria-label="`Thread menu: ${session.title}`"
      />
    </UDropdownMenu>
    <UButton
      v-else
      label="Close thread"
      variant="ghost"
      color="neutral"
      size="sm"
      @click="open = true"
    />
    <component
      :is="device.isMobile.value ? UDrawer : UModal"
      v-model:open="open"
      title="Close this thread?"
      :description="`This discards the thread’s Draft tasks and unapproved plan and stops any running ${pmName} turn. Tasks already on the board or in the Backlog are kept.`"
      :dismissible="!busy"
    >
      <template #body>
        <div class="flex justify-end gap-2 pb-[env(safe-area-inset-bottom)]">
          <UButton
            label="Cancel"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="open = false"
          />
          <UButton
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
