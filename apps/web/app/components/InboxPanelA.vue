<script setup lang="ts">
import { useInboxPanel, type InboxPanelContext } from '~/composables/useInboxPanel'

// Option A, Verdict card (COR-190, inbox-panel-option-a): one card with the
// ask, a one-line summary, the verdict, the criteria as a ✓/✗ checklist, the
// artifacts as a thumbnail strip and the actions. Details are collapsed.
const props = defineProps<{ ctx: InboxPanelContext, mobile?: boolean }>()
const p = useInboxPanel(props.ctx)
const details = ref(false)
watch(() => props.ctx.item.id, () => {
  details.value = false
})
</script>

<template>
  <div
    class="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    data-testid="inbox-panel-option-a"
  >
    <header
      v-if="!mobile"
      class="flex h-14 shrink-0 items-center gap-3 border-b border-default px-4"
    >
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-sm font-medium">
          {{ p.item.value.subject }}
        </h1>
        <InboxPanelMeta
          :p="p"
          kind
        />
      </div>
      <UButton
        label="Task details"
        variant="outline"
        color="neutral"
        size="sm"
        @click="ctx.openTask"
      />
    </header>
    <div :class="['min-h-0 flex-1 overflow-y-auto overscroll-contain', mobile ? 'p-3' : 'p-4']">
      <div class="mx-auto flex max-w-[720px] flex-col gap-3">
        <template v-if="mobile">
          <InboxPanelMeta
            :p="p"
            kind
          />
          <h2 class="-mt-1 text-lg leading-tight font-semibold text-highlighted">
            {{ p.item.value.subject }}
          </h2>
        </template>
        <div class="flex flex-col gap-3 rounded-lg border border-default p-4">
          <p class="flex items-start gap-2 font-medium text-highlighted">
            <UIcon
              :name="p.item.value.resolution ? 'i-lucide-circle-check' : 'i-lucide-arrow-right'"
              :class="['mt-0.5 size-4 shrink-0', p.item.value.resolution ? 'text-success' : 'text-primary']"
            />
            {{ p.ask.value }}
          </p>
          <p class="line-clamp-2 text-sm text-muted">
            {{ p.tldr.value }}
          </p>
          <InboxPanelVerdict :p="p" />
          <ul
            v-if="p.criteria.value.length"
            class="flex flex-col gap-1 text-sm"
          >
            <li
              v-for="c in p.criteria.value"
              :key="c.id"
              class="flex items-center gap-2"
            >
              <UIcon
                :name="c.met ? 'i-lucide-check' : c.met === false ? 'i-lucide-x' : 'i-lucide-minus'"
                :class="['size-4 shrink-0', c.met ? 'text-success' : c.met === false ? 'text-error' : 'text-dimmed']"
              />
              <span :class="['truncate', c.met === false && 'text-error']">{{ c.text.replaceAll('`', '') }}</span>
            </li>
          </ul>
          <InboxPanelArtifacts
            :p="p"
            :size="mobile ? 'sm' : 'md'"
            :files="false"
          />
          <InboxPanelActions
            :ctx="ctx"
            :p="p"
            :size="mobile ? 'md' : 'sm'"
          />
        </div>
        <UButton
          :label="details ? 'Hide details' : 'Details'"
          :trailing-icon="details ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          color="neutral"
          variant="ghost"
          size="sm"
          class="self-start"
          data-testid="inbox-details-toggle"
          @click="details = !details"
        />
        <InboxPanelDetails
          v-if="details"
          :ctx="ctx"
          :p="p"
        />
      </div>
    </div>
    <div
      v-if="p.canAct.value"
      class="shrink-0 border-t border-default p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div class="mx-auto max-w-[720px]">
        <InboxPanelTray :ctx="ctx" />
      </div>
    </div>
    <EvidenceViewer
      :item="p.viewing.value"
      @close="p.viewing.value = null"
    />
  </div>
</template>
