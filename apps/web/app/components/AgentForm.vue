<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { AgentRuntime, CliStatus, CreateAgentInput } from '@corral/contracts'
import { createAgent } from '~/queries/agents'
import { detectedRuntimes, RUNTIME } from '~/utils/labels'

// Add agent (design/settings.md): name, role, runtime and concurrency. The
// runtime menu offers only the CLIs the runner detected (D18).
const props = defineProps<{ clis: CliStatus[] | null, cliError: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const create = useMutation(createAgent)
const toast = useToast()
const device = useDevice()
const UDrawer = resolveComponent('UDrawer')
const UModal = resolveComponent('UModal')

const roles = [{ label: 'Developer', value: 'developer' }, { label: 'Designer', value: 'designer' }, { label: 'Reviewer', value: 'reviewer' }]
const runtimes = computed(() => detectedRuntimes(props.clis ?? []).map(value => ({ label: RUNTIME[value], value })))
const form = reactive<{ name: string, role: CreateAgentInput['role'], runtime: AgentRuntime | undefined, concurrency: number }>({
  name: '', role: 'developer', runtime: undefined, concurrency: 1
})
// Reset each time it opens, picking the first detected runtime
watch([open, runtimes], ([isOpen], [wasOpen]) => {
  if (isOpen && !wasOpen) Object.assign(form, { name: '', role: 'developer', concurrency: 1, runtime: undefined })
  if (!form.runtime || !runtimes.value.some(r => r.value === form.runtime)) form.runtime = runtimes.value[0]?.value
})
const canSave = computed(() => form.name.trim().length > 0 && form.runtime !== undefined && form.concurrency >= 1)
async function save() {
  if (!canSave.value || !form.runtime) return
  try {
    const agent = await create.mutateAsync({ name: form.name.trim(), role: form.role, runtime: form.runtime, concurrency: form.concurrency })
    toast.add({ title: `Added ${agent.name}`, color: 'success' })
    open.value = false
  } catch (e) {
    toast.add({ title: 'Not added', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
</script>

<template>
  <component
    :is="device.isMobile.value ? UDrawer : UModal"
    v-model:open="open"
    title="Add agent"
    description="A developer, designer or reviewer shared by every project. It runs through the CLI you pick, with your own login."
  >
    <template #body>
      <form
        id="add-agent"
        class="flex flex-col gap-4"
        data-testid="add-agent-form"
        @submit.prevent="save"
      >
        <UFormField
          label="Name"
          required
        >
          <UInput
            v-model="form.name"
            :maxlength="80"
            placeholder="e.g. Orion"
            autofocus
            class="w-full"
            data-testid="agent-name"
          />
        </UFormField>
        <UFormField label="Role">
          <USelectMenu
            v-model="form.role"
            :items="roles"
            value-key="value"
            :search-input="false"
            class="w-full"
            data-testid="agent-role"
          />
        </UFormField>
        <UFormField
          label="Runtime"
          :help="cliError ? undefined : 'Only CLIs installed in the runner are offered.'"
          :error="cliError ?? (clis && !runtimes.length ? 'The runner has no agent CLI installed.' : undefined)"
        >
          <USelectMenu
            v-model="form.runtime"
            :items="runtimes"
            value-key="value"
            :search-input="false"
            :loading="!clis && !cliError"
            placeholder="Checking the runner…"
            class="w-full"
            data-testid="agent-runtime"
          />
        </UFormField>
        <UFormField
          label="Concurrency"
          help="How many tasks it works on at once."
        >
          <UInputNumber
            v-model="form.concurrency"
            :min="1"
          />
        </UFormField>
        <p class="text-xs text-muted">
          Instructions: <span class="font-mono">.corral/agents/{{ form.role }}.md</span> in each repository.
        </p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2 pb-[env(safe-area-inset-bottom)]">
        <UButton
          label="Cancel"
          variant="outline"
          color="neutral"
          @click="open = false"
        />
        <UButton
          label="Add agent"
          type="submit"
          form="add-agent"
          :loading="create.isPending.value"
          :disabled="!canSave"
          data-testid="add-agent-save"
        />
      </div>
    </template>
  </component>
</template>
