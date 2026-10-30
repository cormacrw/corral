<script setup lang="ts">
import { useInboxPanel, type InboxPanelContext } from '~/composables/useInboxPanel'

// Option D, TL;DR + tabs (COR-190, inbox-panel-option-d): a one-to-two line
// summary, the actions and the verdict on top, then tabs. The first tab is an
// overview of the artifacts; the criteria with notes, the review history and
// the full message each have a tab of their own.
const props = defineProps<{ ctx: InboxPanelContext, mobile?: boolean }>()
const p = useInboxPanel(props.ctx)
const tab = ref('overview')
watch(() => props.ctx.item.id, () => {
  tab.value = 'overview'
})
const tabs = computed(() => [
  { label: 'Overview', value: 'overview' },
  ...(p.criteria.value.length ? [{ label: `Criteria ${p.met.value}/${p.criteria.value.length}`, value: 'criteria' }] : []),
  ...(p.history.value.length ? [{ label: 'Review', value: 'review' }] : []),
  { label: 'Message', value: 'message' }
])
const explain: Record<string, string> = {
  approve: 'Merges the PR once the checks pass.',
  request_changes: 'Sends it back to the developer with your note.',
  clarify: 'Your answer goes to the developer, who carries on.',
  send_back: 'Moves the task to the Backlog.',
  delete: 'Removes the task.',
  resolve: 'Starts a new run from where the task is.'
}
</script>

<template>
  <div
    class="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    data-testid="inbox-panel-option-d"
  >
    <div :class="['flex shrink-0 flex-col gap-2 border-b border-default', mobile ? 'p-3' : 'px-5 pt-4 pb-3']">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <InboxPanelMeta
            :p="p"
            kind
          />
          <h1 class="mt-0.5 text-lg leading-tight font-semibold text-highlighted">
            {{ p.item.value.subject }}
          </h1>
        </div>
        <UButton
          v-if="!mobile"
          icon="i-lucide-panel-right"
          aria-label="Task details"
          title="Task details"
          variant="ghost"
          color="neutral"
          size="sm"
          @click="ctx.openTask"
        />
      </div>
      <p class="line-clamp-2 text-sm">
        <span class="font-medium">TL;DR</span> <span class="text-muted">{{ p.tldr.value }}</span>
      </p>
      <InboxPanelVerdict :p="p" />
      <div :class="['flex gap-2', mobile ? 'flex-col' : 'flex-wrap items-center justify-between']">
        <InboxPanelActions
          :ctx="ctx"
          :p="p"
          :size="mobile ? 'md' : 'sm'"
        />
        <InboxPanelArtifacts
          :p="p"
          :files="false"
          size="sm"
          class="[&>button]:hidden"
        />
      </div>
    </div>
    <UTabs
      v-model="tab"
      :items="tabs"
      :content="false"
      variant="link"
      size="sm"
      :class="['shrink-0', mobile ? 'px-1' : 'px-3']"
      data-testid="inbox-details-toggle"
    />
    <div :class="['min-h-0 flex-1 overflow-y-auto overscroll-contain', mobile ? 'p-3' : 'p-5']">
      <div
        v-if="tab === 'overview'"
        class="flex flex-col gap-4"
      >
        <div
          v-if="p.images.value.length"
          :class="['grid gap-2', mobile ? 'grid-cols-2' : 'grid-cols-3']"
        >
          <button
            v-for="e in p.images.value"
            :key="e.id"
            type="button"
            class="overflow-hidden rounded-md border border-default text-start hover:ring-2 hover:ring-primary"
            @click="p.viewing.value = e"
          >
            <img
              :src="e.url ?? undefined"
              :alt="e.fileName ?? ''"
              class="aspect-video w-full object-cover object-top"
            >
            <span class="block truncate px-2 py-1 text-xs text-muted">{{ e.fileName }}</span>
          </button>
        </div>
        <InboxPanelArtifacts
          v-if="p.files.value.length"
          :p="p"
          :links="false"
          class="[&>button.group]:hidden"
        />
        <ul
          v-if="p.canAct.value && !p.images.value.length"
          class="flex flex-col gap-2 text-sm"
        >
          <li
            v-for="a in ctx.actions"
            :key="a.value"
            class="flex items-center gap-2"
          >
            <UIcon
              :name="a.icon"
              class="size-4 text-muted"
            />
            <span class="font-medium">{{ a.label }}</span>
            <span class="text-muted">{{ explain[a.value] }}</span>
          </li>
        </ul>
        <p
          v-if="!p.canAct.value && !p.images.value.length && !p.files.value.length"
          class="text-sm text-muted"
        >
          {{ p.ask.value }}
        </p>
      </div>
      <InboxPanelDetails
        v-else-if="tab === 'criteria'"
        :ctx="ctx"
        :p="p"
        section="criteria"
      />
      <InboxPanelDetails
        v-else-if="tab === 'review'"
        :ctx="ctx"
        :p="p"
        section="history"
      />
      <InboxPanelDetails
        v-else
        :ctx="ctx"
        :p="p"
        section="message"
      />
    </div>
    <div
      v-if="p.canAct.value"
      class="shrink-0 border-t border-default p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <InboxPanelTray :ctx="ctx" />
    </div>
    <EvidenceViewer
      :item="p.viewing.value"
      @close="p.viewing.value = null"
    />
  </div>
</template>
