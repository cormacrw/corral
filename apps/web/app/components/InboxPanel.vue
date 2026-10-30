<script setup lang="ts">
import type { Evidence } from '@corral/contracts'
import { useInboxPanel, type InboxPanelContext, type InboxPanelTab } from '~/composables/useInboxPanel'

// The Inbox message panel, Option D (design/inbox.md): what's needed to decide
// up front, then tabs for everything else. On a phone (design/mobile.md) the
// actions and the composer move to the bottom bar.
const props = defineProps<{ ctx: InboxPanelContext, mobile?: boolean }>()
const p = useInboxPanel(props.ctx)
const tray = ref<{ send: () => Promise<boolean> } | null>(null)
defineExpose({ send: () => tray.value?.send() ?? Promise.resolve(false) })
const viewing = ref<Evidence | null>(null)

const tabs = computed(() => [
  { label: 'Overview', value: 'overview' },
  ...(p.criteria.value.length ? [{ label: `Criteria ${p.met.value}/${p.criteria.value.length}`, value: 'criteria' }] : []),
  ...(p.history.value.length ? [{ label: 'Review', value: 'review' }] : []),
  { label: 'Message', value: 'message' }
])
// A tab's content can load after the page asks for it, or go away
const openTab = computed(() => tabs.value.some(t => t.value === props.ctx.tab) ? props.ctx.tab : 'overview')
const details = computed(() => openTab.value as Exclude<InboxPanelTab, 'overview'>)
const hasEvidence = computed(() => p.images.value.length > 0 || p.others.value.length > 0)
// Approval can't be taken without its task, so there's nothing to explain
const actionHelp = computed(() => props.ctx.actions.filter(a => !(a.value === 'approve' && props.ctx.taskLoadFailed)))
const loading = computed(() => props.ctx.taskLoading || (p.isReview.value && props.ctx.evidenceLoading))
</script>

<template>
  <div
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    data-testid="inbox-panel-option-d"
  >
    <div :class="['flex max-h-[60%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-default', mobile ? 'p-3' : 'px-5 pt-4 pb-3']">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <InboxPanelMeta :p="p" />
          <h1 class="mt-0.5 text-lg leading-tight font-semibold text-highlighted">
            {{ ctx.item.subject }}
          </h1>
        </div>
        <UButton
          v-if="!mobile && ctx.task"
          icon="i-lucide-panel-right"
          aria-label="Task details"
          title="Task details"
          variant="ghost"
          color="neutral"
          size="sm"
          :aria-pressed="ctx.taskOpen"
          @click="ctx.toggleTask"
        />
      </div>
      <InboxMessage
        v-if="ctx.item.message"
        :item="ctx.item"
        :evidence="ctx.evidence"
        summary
      />
      <p
        v-else
        class="line-clamp-2 text-sm"
      >
        <span class="font-medium">TL;DR</span> <span class="text-muted">{{ p.tldr.value }}</span>
      </p>
      <USkeleton
        v-if="ctx.taskLoading && p.isReview.value"
        class="h-5 w-72"
        data-testid="inbox-verdict-loading"
      />
      <InboxPanelVerdict
        v-else
        :p="p"
      />
      <div class="flex flex-wrap items-center justify-between gap-2">
        <InboxPanelActions
          v-if="!mobile"
          :ctx="ctx"
          :p="p"
        />
        <InboxPanelArtifacts
          :ctx="ctx"
          :p="p"
        />
      </div>
      <UAlert
        v-if="ctx.taskLoadFailed"
        color="error"
        variant="subtle"
        title="Couldn't load this task"
        :actions="[{ label: 'Retry', onClick: ctx.retryTask }]"
      />
    </div>
    <UTabs
      :model-value="openTab"
      :items="tabs"
      :content="false"
      variant="link"
      size="sm"
      :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0' }"
      :class="['shrink-0', mobile ? 'px-1' : 'px-3']"
      data-testid="inbox-tabs"
      @update:model-value="ctx.setTab($event as InboxPanelTab)"
    />
    <div
      :class="['min-h-0 flex-1 overflow-y-auto overscroll-contain', mobile ? 'p-3' : 'p-5']"
      data-testid="inbox-detail-scroller"
    >
      <div
        v-if="openTab === 'overview' && loading"
        :class="['grid gap-2', mobile ? 'grid-cols-2' : 'grid-cols-3']"
        data-testid="inbox-overview-loading"
      >
        <USkeleton
          v-for="i in 3"
          :key="i"
          class="aspect-video w-full"
        />
      </div>
      <div
        v-else-if="openTab === 'overview'"
        class="flex flex-col gap-4"
      >
        <p
          v-if="!p.canAct.value"
          class="text-sm text-muted"
          data-testid="inbox-read-only"
        >
          {{ p.readOnlyNote.value }}
        </p>
        <div
          v-if="p.isReview.value && p.images.value.length"
          :class="['grid gap-2', mobile ? 'grid-cols-2' : 'grid-cols-3']"
        >
          <button
            v-for="e in p.images.value"
            :key="e.id"
            type="button"
            class="overflow-hidden rounded-md border border-default text-start hover:ring-2 hover:ring-primary focus-visible:ring-2 focus-visible:ring-primary"
            :aria-label="`Open ${e.fileName}`"
            @click="viewing = e"
          >
            <img
              :src="e.url ?? undefined"
              :alt="e.note || e.fileName || ''"
              class="aspect-video w-full object-cover object-top"
            >
            <span class="block truncate px-2 py-1 text-xs text-muted">{{ e.fileName }}</span>
          </button>
        </div>
        <div
          v-if="p.isReview.value && p.others.value.length"
          class="flex flex-wrap items-center gap-2"
        >
          <UButton
            v-for="e in p.others.value"
            :key="e.id"
            :label="e.fileName ?? 'File'"
            :icon="e.contentType?.startsWith('video/') ? 'i-lucide-video' : 'i-lucide-file-text'"
            color="neutral"
            variant="ghost"
            size="xs"
            class="max-w-48"
            :ui="{ label: 'truncate' }"
            @click="viewing = e"
          />
        </div>
        <ul
          v-if="p.canAct.value && !(p.isReview.value && hasEvidence)"
          class="flex flex-col gap-2 text-sm"
          data-testid="inbox-action-help"
        >
          <li
            v-for="a in actionHelp"
            :key="a.value"
            class="flex items-center gap-2"
          >
            <UIcon
              :name="a.icon"
              class="size-4 shrink-0 text-muted"
            />
            <span class="font-medium">{{ a.label }}</span>
            <span class="text-muted">{{ p.explanations.value[a.value] }}</span>
          </li>
        </ul>
      </div>
      <InboxPanelDetails
        v-else
        :ctx="ctx"
        :p="p"
        :section="details"
      />
    </div>
    <InboxPanelThumbBar
      v-if="p.canAct.value && mobile"
      ref="tray"
      :ctx="ctx"
    />
    <div
      v-else-if="p.canAct.value"
      class="shrink-0 border-t border-default p-3"
    >
      <InboxPanelTray
        ref="tray"
        :ctx="ctx"
      />
    </div>
    <EvidenceViewer v-model="viewing" />
  </div>
</template>
