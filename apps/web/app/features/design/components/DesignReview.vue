<script setup lang="ts">
import { shortSha } from '@corral/core'
import { planThreadPath } from '~/utils/routes'
import { useQuery } from '@tanstack/vue-query'
import type { Task } from '@corral/contracts'
import type { DesignViewport } from '~/features/design/components/DesignViewportFrame.vue'
import { taskDesignsQuery } from '~/queries/tasks'
import { DESIGN_VERSION_STATUS } from '~/utils/labels'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// A design task's versions in task detail (D20): the live prototype in its
// sandboxed iframe at a desktop or mobile viewport, the version's design.md
// and screenshots, and the human's Approve and Request changes.
const props = defineProps<{ task: Task, slug: string, mobile?: boolean }>()
const toast = useToast()

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
const viewport = ref<DesignViewport>(props.mobile ? 'mobile' : 'desktop')
const VIEWPORT_ITEMS = [{ label: 'Desktop', value: 'desktop', icon: 'i-hugeicons-computer' }, { label: 'Mobile', value: 'mobile', icon: 'i-hugeicons-smart-phone-01' }]
</script>

<template>
  <section aria-label="Design">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h3 class="me-auto text-xs font-medium text-muted-foreground">
        Design
      </h3>
      <template v-if="selected">
        <AppSelect
          v-model="selectedId"
          :items="versionItems"
          aria-label="Version"
          class="w-56"
        />
        <AppTabs
          v-model="viewport"
          :items="VIEWPORT_ITEMS"
          :content="false"
          aria-label="Viewport"
        />
        <AppButton
          :to="`/designs/${selected.id}`"
          target="_blank"
          icon="i-hugeicons-link-square-02"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open prototype full size"
        />
      </template>
    </div>

    <AppLoadError
      v-if="designs.isLoadingError.value"
      title="Couldn't load the design"
      :description="designs.error.value?.message"
      :retry="designs.refetch"
    />
    <p
      v-else-if="loaded && !selected"
      class="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground"
    >
      No versions yet. The designer submits one with the prototype, design.md and screenshots.
    </p>

    <div
      v-else-if="selected"
      class="flex flex-col gap-3"
    >
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <AppBadge
          :label="DESIGN_VERSION_STATUS[selected.status].label"
          :color="DESIGN_VERSION_STATUS[selected.status].color"
          variant="subtle"
          size="sm"
        />
        <span>v{{ selected.version }} · <TimeAgo :at="selected.createdAt" /> · <span class="font-mono">{{ selected.branch }}@{{ shortSha(selected.commitSha) }}</span></span>
        <span
          v-if="selected.status === 'superseded'"
          class="text-warning"
        >A later version was approved; this one is kept for reference.</span>
      </div>

      <DesignViewportFrame :viewport="viewport">
        <DesignPreview
          :key="selected.id"
          :version-id="selected.id"
          :title="`${task.ref} v${selected.version} prototype`"
        />
      </DesignViewportFrame>

      <div
        v-if="selected.planSessionId"
        class="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2 text-sm"
      >
        <Icon
          name="i-hugeicons-bubble-chat"
          class="size-4 text-success"
        />
        <span class="me-auto">Approving v{{ selected.version }} started planning its build.</span>
        <AppButton
          label="Open Plan session"
          trailing-icon="i-hugeicons-arrow-right-02"
          variant="link"
          size="sm"
          :to="planThreadPath(selected.planSessionId)"
          data-testid="design-plan-session"
        />
      </div>

      <div
        v-if="selected.feedback"
        class="rounded-lg border border-border bg-muted px-3 py-2 text-sm"
      >
        <p class="mb-1 text-xs font-medium text-muted-foreground">
          Your feedback on v{{ selected.version }}
        </p>
        <MarkdownText
          :text="selected.feedback"
          breaks
        />
      </div>

      <DesignDecision
        :task="task"
        :slug="slug"
        :versions="versions"
        :selected="selected"
      />

      <DesignScreenshots
        v-if="selected.screenshots.length > 0"
        :screenshots="selected.screenshots"
        :mobile="mobile"
      />

      <details
        class="rounded-lg border border-border"
        open
      >
        <summary class="cursor-pointer px-3 py-2 font-mono text-xs text-muted-foreground">
          design.md
        </summary>
        <MarkdownText
          :text="selected.spec"
          class="border-t border-border px-3 py-2 text-sm"
        />
      </details>
    </div>
  </section>
</template>
