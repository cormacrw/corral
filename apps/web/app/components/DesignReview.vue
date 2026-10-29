<script setup lang="ts">
import type { DesignVersion, Task } from '@corral/contracts'
import { api, ApiError } from '~/composables/useApi'
import { DESIGN_VERSION_STATUS, timeAgo } from '~/utils/labels'

// A design task's versions in task detail (D20): the live prototype in its
// sandboxed iframe at a desktop or mobile viewport, the version's design.md
// and screenshots, and the human's Approve and Request changes.
const props = defineProps<{ task: Task, slug: string, mobile?: boolean }>()
const emit = defineEmits<{ updated: [task: Task] }>()
const toast = useToast()

const versions = ref<DesignVersion[]>([])
const loaded = ref(false)
const selectedId = ref<string | undefined>()
const selected = computed(() => versions.value.find(v => v.id === selectedId.value) ?? versions.value[0] ?? null)

async function load() {
  if (!props.slug) return
  try {
    versions.value = await api.tasks.designs(props.slug, props.task.number)
    if (!versions.value.some(v => v.id === selectedId.value)) selectedId.value = versions.value[0]?.id
  } catch (e) {
    toast.add({ title: 'Couldn\'t load the design', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    loaded.value = true
  }
}
// A new submission or a decision changes the task, and so its versions
watch(() => [props.slug, props.task.updatedAt], load, { immediate: true })

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
const decidable = computed(() => props.task.status === 'human_review' && selected.value?.status === 'submitted')
const requesting = ref(false)
const feedback = ref('')
const approving = ref(false)
// Goes to the PM in the Plan session the approval opens for the build
const note = ref('')
function fail(e: unknown) {
  toast.add({ title: 'Not saved', description: e instanceof ApiError ? e.message : String(e), color: 'error' })
}
async function approve() {
  if (!selected.value) return
  approving.value = true
  try {
    emit('updated', await api.tasks.approveDesign(props.slug, props.task.number, selected.value.version, note.value.trim() || undefined))
    toast.add({ title: `Design v${selected.value.version} approved`, description: 'The PM is planning the build.', color: 'success' })
    note.value = ''
    await load()
  } catch (e) {
    fail(e)
  } finally {
    approving.value = false
  }
}
// The feedback goes to the developer as a pinned comment, kept on the
// version too, and the task goes back to In progress (D20)
async function requestChanges(text: string): Promise<boolean> {
  try {
    const { task } = await api.inbox.act(props.task.id, { action: 'request_changes', text })
    if (task) emit('updated', task)
    feedback.value = ''
    requesting.value = false
    toast.add({ title: 'Changes requested', description: 'The developer picks it up on the next run.', color: 'success' })
    await load()
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

    <p
      v-if="loaded && !selected"
      class="rounded-lg border border-dashed border-default px-3 py-6 text-center text-sm text-muted"
    >
      No versions yet. The developer submits one with the prototype, design.md and screenshots.
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
        <span>v{{ selected.version }} · {{ timeAgo(selected.createdAt) }} · <span class="font-mono">{{ selected.branch }}@{{ selected.commitSha.slice(0, 7) }}</span></span>
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
        v-if="decidable"
        class="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="me-auto text-sm">v{{ selected.version }} is waiting on your review.</span>
          <UButton
            label="Request changes"
            icon="i-lucide-pencil"
            variant="outline"
            color="neutral"
            size="sm"
            @click="requesting = !requesting"
          />
          <UButton
            :label="`Approve v${selected.version}`"
            icon="i-lucide-check"
            size="sm"
            :loading="approving"
            @click="approve"
          />
        </div>
        <UInput
          v-if="!requesting"
          v-model="note"
          placeholder="Note for the build plan (optional)"
          aria-label="Approval note for the PM"
          size="sm"
        />
        <PromptComposer
          v-if="requesting"
          v-model="feedback"
          placeholder="What should change? Paste or drop screenshots to show it."
          hint="Goes to the developer, who submits a new version."
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
