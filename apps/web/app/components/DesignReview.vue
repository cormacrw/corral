<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query'
import { actOnInboxItem } from '~/queries/inbox'
import { approveDesign, moveTask, taskDesignsQuery } from '~/queries/tasks'
import type { Task } from '@corral/contracts'
import { ApiError } from '~/queries/client'
import { DESIGN_VERSION_STATUS } from '~/utils/labels'
import TimeAgo from '~/components/TimeAgo.vue'

// A design task's versions in task detail (D20): the live prototype in its
// sandboxed iframe at a desktop or mobile viewport, the version's design.md
// and screenshots, and the human's Approve and Request changes.
const props = defineProps<{ task: Task, slug: string, mobile?: boolean }>()
const toast = useToast()
const transition = useMutation(moveTask)
const act = useMutation(actOnInboxItem)
const approval = useMutation(approveDesign)

const designs = useQuery(computed(() => ({ ...taskDesignsQuery({ ...props.task, slug: props.slug }), enabled: Boolean(props.slug) })))
const versions = computed(() => designs.data.value ?? [])
const loaded = computed(() => designs.isSuccess.value)
const selectedId = ref<string | undefined>()
const selected = computed(() => versions.value.find(v => v.id === selectedId.value) ?? versions.value[0] ?? null)
watch(versions, () => {
  if (!versions.value.some(v => v.id === selectedId.value)) selectedId.value = versions.value[0]?.id
}, { immediate: true })
watch(designs.error, (e) => {
  if (e) toast.add({ title: 'Couldn\'t load the design', description: e.message, color: 'error' })
})

const versionItems = computed(() => versions.value.map(v => ({ label: `v${v.version} · ${DESIGN_VERSION_STATUS[v.status].label}`, value: v.id })))

// The prototype renders at the viewport's real size and is scaled down to
// fit, so a desktop layout stays a desktop layout on a narrow screen
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } } as const
const viewport = ref<keyof typeof VIEWPORTS>(props.mobile ? 'mobile' : 'desktop')
const frame = useTemplateRef<HTMLElement>('frame')
const available = ref(0)
let observer: ResizeObserver | null = null
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    available.value = entry?.contentRect.width ?? 0
  })
  watch(frame, (el) => {
    observer?.disconnect()
    if (el) observer?.observe(el)
  }, { immediate: true })
})
onBeforeUnmount(() => observer?.disconnect())
const size = computed(() => VIEWPORTS[viewport.value])
const scale = computed(() => available.value > 0 ? Math.min(1, available.value / size.value.width) : 1)

// Only the version waiting on the human can be decided
const decidable = computed(() => ['human_review', 'ready_to_merge'].includes(props.task.status) && (selected.value?.status === 'submitted' || (selected.value?.status === 'approved' && selected.value.id === versions.value[0]?.id && !versions.value.some(v => v.status === 'submitted'))))
const reopenable = computed(() => props.task.status === 'approved')
const requesting = ref(false)
const feedback = ref('')
// Saved on the task and sent to the PM in the build Plan session
const note = ref('')
function fail(e: unknown) {
  toast.add({ title: 'Not saved', description: e instanceof ApiError ? e.message : String(e), color: 'error' })
}
async function approve() {
  if (!selected.value) return
  const { version } = selected.value
  try {
    await approval.mutateAsync({ task: { ...props.task, slug: props.slug }, version, note: note.value.trim() || undefined })
    toast.add({ title: `Design v${version} approved`, description: 'The PM is planning the build.', color: 'success' })
    note.value = ''
  } catch (e) {
    fail(e)
  }
}
// The feedback goes to the designer as a pinned comment, kept on the
// version too, and the task goes back to In progress (D20)
async function requestChanges(text: string): Promise<boolean> {
  try {
    if (reopenable.value) {
      await transition.mutateAsync({ task: { ...props.task, slug: props.slug }, input: { type: 'human_request_changes', feedback: text }, status: 'in_progress' })
    } else {
      await act.mutateAsync({ taskId: props.task.id, input: { action: 'request_changes', text } })
    }
    feedback.value = ''
    requesting.value = false
    toast.add({ title: 'Changes requested', description: 'The designer picks it up on the next run.', color: 'success' })
    return true
  } catch (e) {
    fail(e)
    return false
  }
}
</script>

<template>
  <section aria-label="Design">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h3 class="me-auto text-xs font-medium text-muted">
        Design
      </h3>
      <template v-if="selected">
        <USelect
          v-model="selectedId"
          :items="versionItems"
          size="sm"
          aria-label="Version"
          class="w-56"
        />
        <UTabs
          v-model="viewport"
          :items="[{ label: 'Desktop', value: 'desktop', icon: 'i-lucide-monitor' }, { label: 'Mobile', value: 'mobile', icon: 'i-lucide-smartphone' }]"
          :content="false"
          size="xs"
          aria-label="Viewport"
        />
        <UButton
          :to="`/designs/${selected.id}`"
          target="_blank"
          icon="i-lucide-external-link"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open prototype full size"
        />
      </template>
    </div>

    <UAlert
      v-if="designs.isLoadingError.value"
      color="error"
      variant="subtle"
      title="Couldn't load the design"
      :description="designs.error.value?.message"
      :actions="[{ label: 'Retry', onClick: () => designs.refetch() }]"
    />
    <p
      v-else-if="loaded && !selected"
      class="rounded-lg border border-dashed border-default px-3 py-6 text-center text-sm text-muted"
    >
      No versions yet. The designer submits one with the prototype, design.md and screenshots.
    </p>

    <div
      v-else-if="selected"
      class="flex flex-col gap-3"
    >
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
        <UBadge
          :label="DESIGN_VERSION_STATUS[selected.status].label"
          :color="DESIGN_VERSION_STATUS[selected.status].color"
          variant="subtle"
          size="sm"
        />
        <span>v{{ selected.version }} · <TimeAgo :at="selected.createdAt" /> · <span class="font-mono">{{ selected.branch }}@{{ selected.commitSha.slice(0, 7) }}</span></span>
        <span
          v-if="selected.status === 'superseded'"
          class="text-warning"
        >A later version was approved; this one is kept for reference.</span>
      </div>

      <div
        ref="frame"
        class="w-full"
      >
        <div
          class="mx-auto overflow-hidden rounded-lg border border-default bg-white shadow-xs"
          :style="{ width: `${size.width * scale}px`, height: `${size.height * scale}px` }"
          :data-viewport="viewport"
        >
          <div
            class="origin-top-left"
            :style="{ width: `${size.width}px`, height: `${size.height}px`, transform: `scale(${scale})` }"
          >
            <DesignPreview
              :key="selected.id"
              :version-id="selected.id"
              :title="`${task.ref} v${selected.version} prototype`"
            />
          </div>
        </div>
      </div>

      <div
        v-if="selected.planSessionId"
        class="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2 text-sm"
      >
        <UIcon
          name="i-lucide-messages-square"
          class="size-4 text-success"
        />
        <span class="me-auto">Approving v{{ selected.version }} started planning its build.</span>
        <UButton
          label="Open Plan session"
          trailing-icon="i-lucide-arrow-right"
          variant="link"
          size="sm"
          :to="`/plan/${selected.planSessionId}`"
          data-testid="design-plan-session"
        />
      </div>

      <div
        v-if="selected.feedback"
        class="rounded-lg border border-default bg-elevated px-3 py-2 text-sm"
      >
        <p class="mb-1 text-xs font-medium text-muted">
          Your feedback on v{{ selected.version }}
        </p>
        <MarkdownText
          :text="selected.feedback"
          breaks
        />
      </div>

      <div
        v-if="decidable || reopenable"
        class="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="me-auto text-sm">{{ reopenable ? 'Design approved. Reopen with feedback to request a new version.' : `v${selected.version} is waiting on your review.` }}</span>
          <UButton
            :label="reopenable ? 'Reopen design' : 'Request changes'"
            icon="i-lucide-pencil"
            variant="outline"
            color="neutral"
            size="sm"
            @click="requesting = !requesting"
          />
          <UButton
            v-if="decidable"
            :label="`Approve v${selected.version}`"
            icon="i-lucide-check"
            size="sm"
            :loading="approval.isPending.value"
            @click="approve"
          />
        </div>
        <UInput
          v-if="decidable && !requesting"
          v-model="note"
          placeholder="Note for the build plan (optional)"
          aria-label="Approval note for the PM"
          size="sm"
        />
        <PromptComposer
          v-if="requesting"
          v-model="feedback"
          placeholder="What should change? Paste or drop screenshots to show it."
          hint="Goes to the designer, who submits a new version."
          submit-label="Request changes"
          :project="slug"
          @submit="requestChanges"
        />
      </div>

      <div v-if="selected.screenshots.length > 0">
        <h4 class="mb-1 text-xs font-medium text-muted">
          Screenshots
        </h4>
        <ul :class="['grid gap-2', mobile ? 'grid-cols-2' : 'grid-cols-3']">
          <li
            v-for="shot in selected.screenshots"
            :key="shot.url"
          >
            <a
              :href="shot.url"
              target="_blank"
              rel="noopener"
              class="block overflow-hidden rounded-md border border-default hover:ring-2 hover:ring-primary"
            >
              <img
                :src="shot.url"
                :alt="shot.fileName"
                loading="lazy"
                class="aspect-video w-full bg-muted object-cover object-top"
              >
              <span class="block truncate px-2 py-1 text-xs text-muted">{{ shot.fileName }}</span>
            </a>
          </li>
        </ul>
      </div>

      <details
        class="rounded-lg border border-default"
        open
      >
        <summary class="cursor-pointer px-3 py-2 font-mono text-xs text-muted">
          design.md
        </summary>
        <MarkdownText
          :text="selected.spec"
          class="border-t border-default px-3 py-2 text-sm"
        />
      </details>
    </div>
  </section>
</template>
