<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PlanSession, Project } from '@corral/contracts'
import { runtimeLabel } from '~/utils/labels'
import { usePlanRunner } from '~/features/plan/composables/usePlanRunner'

// The bottom of a Plan conversation: the runner's state and the reply composer
const props = defineProps<{
  sessionId: string
  session: PlanSession | null
  project: Project | null
  busy: boolean
  // Grill me sends straight away, so it stops whenever a send would
  cantSend: boolean
  // Bound with @send. Resolving to false means it wasn't sent, as on PromptComposer.
  onSend: (message: string) => Promise<boolean>
}>()
const emit = defineEmits<{ grill: [message: string] }>()
const text = defineModel<string>('text', { required: true })
const taskRef = defineModel<string | null>('taskRef', { required: true })

const device = useDevice()
const { pm, offline, unavailable } = usePlanRunner()
const placeholder = computed(() => offline.value && device.isMobile.value ? unavailable.value : `Reply to ${pm.value?.name ?? 'the PM'}…`)
const composer = ref<{ focus: () => void } | null>(null)
defineExpose({ focus: () => composer.value?.focus() })
</script>

<template>
  <div :class="['shrink-0 border-t border-border p-3', device.isMobile.value && 'pb-[max(0.75rem,env(safe-area-inset-bottom))]']">
    <div class="mx-auto w-full max-w-[768px]">
      <PlanRunnerOffline class="mb-2" />
      <PromptComposer
        :key="props.sessionId"
        ref="composer"
        v-model="text"
        :placeholder="placeholder"
        :disabled="offline || Boolean(props.session?.activeRunId)"
        :busy="props.busy"
        :allow-empty="taskRef !== null"
        :project="props.project?.slug"
        :draft-key="`plan:${props.sessionId}`"
        @submit="props.onSend"
      >
        <template #header>
          <PlanAttachedTask
            v-if="taskRef"
            :task-ref="taskRef"
            @remove="taskRef = null"
          />
        </template>
        <template #send-tools>
          <!-- Locked: an agent session only resumes on the vendor that made it
               (D18). Plain text, not a disabled button, which would grey out
               the whole composer. -->
          <AppTooltip
            v-if="props.session"
            text="A session keeps the runtime it started with"
          >
            <span
              tabindex="0"
              class="flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground"
              aria-label="Runtime (locked)"
              data-testid="plan-runtime-locked"
            >
              <Icon
                name="i-hugeicons-square-lock-02"
                class="size-3.5"
              />
              {{ runtimeLabel(props.session.runtime) }}
            </span>
          </AppTooltip>
        </template>
        <template #tools>
          <PlanRefineMenu
            v-model="taskRef"
            :project="props.project"
          />
          <!-- First on phones, so it's in reach without scrolling the toolbar -->
          <PlanGrillButton
            :draft="text"
            :disabled="props.cantSend"
            :class="device.isMobile.value && 'order-first'"
            @send="emit('grill', $event)"
          />
        </template>
      </PromptComposer>
    </div>
  </div>
</template>
