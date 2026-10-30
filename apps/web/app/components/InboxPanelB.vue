<script setup lang="ts">
import { useInboxPanel, type InboxPanelContext } from '~/composables/useInboxPanel'

// Option B, Artifacts first (COR-190, inbox-panel-option-b): the screenshots
// lead as a large gallery; the ask, verdict and actions sit in a slim rail
// (a strip under the gallery on a phone) and the text opens in a sheet.
// Items without screenshots lead with their one-line summary instead.
const props = defineProps<{ ctx: InboxPanelContext, mobile?: boolean }>()
const p = useInboxPanel(props.ctx)
const shown = ref(0)
const reading = ref(false)
watch(() => props.ctx.item.id, () => {
  shown.value = 0
  reading.value = false
})
const hero = computed(() => p.images.value[shown.value] ?? p.images.value[0] ?? null)
</script>

<template>
  <div
    :class="['flex h-full min-h-0 min-w-0 flex-1', mobile ? 'flex-col' : 'flex-row']"
    data-testid="inbox-panel-option-b"
  >
    <!-- The stage: the gallery, or the summary when there's nothing to look at -->
    <div :class="['flex min-h-0 min-w-0 flex-col bg-muted', mobile ? 'shrink-0' : 'flex-1']">
      <template v-if="hero">
        <button
          type="button"
          :class="['flex min-h-0 items-center justify-center p-3', mobile ? 'h-52' : 'flex-1 p-6']"
          :aria-label="`Open ${hero.fileName}`"
          @click="p.viewing.value = hero"
        >
          <img
            :src="hero.url ?? undefined"
            :alt="hero.note || hero.fileName || ''"
            class="max-h-full max-w-full rounded-md border border-default object-contain shadow-sm"
          >
        </button>
        <div class="flex shrink-0 items-center gap-2 overflow-x-auto px-3 pb-3">
          <button
            v-for="(e, i) in p.images.value"
            :key="e.id"
            type="button"
            :class="['h-12 w-20 shrink-0 overflow-hidden rounded border bg-default', i === shown ? 'border-primary ring-2 ring-primary' : 'border-default']"
            :aria-label="`Open ${e.fileName}`"
            @click="shown = i; p.view(e)"
          >
            <img
              :src="e.url ?? undefined"
              alt=""
              class="size-full object-cover object-top"
            >
          </button>
          <span class="ms-auto shrink-0 text-xs text-muted">{{ shown + 1 }} / {{ p.images.value.length }}</span>
        </div>
      </template>
      <div
        v-else
        :class="['flex flex-col justify-center gap-3', mobile ? 'p-4' : 'flex-1 p-10']"
      >
        <UIcon
          :name="p.kind.value.icon"
          :class="['size-8', p.kind.value.color]"
        />
        <p :class="['font-medium text-highlighted', mobile ? 'text-lg' : 'max-w-2xl text-2xl leading-snug']">
          {{ p.tldr.value }}
        </p>
      </div>
    </div>

    <!-- The rail: what it is, the ask, the verdict and the actions -->
    <aside :class="['flex min-h-0 flex-col', mobile ? 'flex-1' : 'w-[340px] shrink-0 border-s border-default']">
      <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4">
        <InboxPanelMeta
          :p="p"
          kind
        />
        <h1 class="text-base leading-tight font-semibold text-highlighted">
          {{ p.item.value.subject }}
        </h1>
        <p class="text-sm font-medium">
          {{ p.ask.value }}
        </p>
        <InboxPanelVerdict
          :p="p"
          stack
        />
        <InboxPanelArtifacts
          :p="p"
          size="sm"
          :files="false"
          class="[&>button]:hidden"
        />
        <InboxPanelActions
          :ctx="ctx"
          :p="p"
          :block="!mobile"
          :size="mobile ? 'md' : 'sm'"
          :class="!mobile && 'flex-col'"
        />
        <div class="flex flex-wrap gap-x-3">
          <UButton
            label="Read message"
            icon="i-lucide-text"
            variant="link"
            color="neutral"
            size="sm"
            class="px-0"
            data-testid="inbox-details-toggle"
            @click="reading = true"
          />
          <UButton
            v-if="!mobile"
            label="Task details"
            icon="i-lucide-panel-right"
            variant="link"
            color="neutral"
            size="sm"
            class="px-0"
            @click="ctx.openTask"
          />
        </div>
      </div>
      <div
        v-if="p.canAct.value"
        class="shrink-0 border-t border-default p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <InboxPanelTray :ctx="ctx" />
      </div>
    </aside>
    <InboxPanelSheet
      v-model:open="reading"
      :title="p.item.value.subject"
      :mobile="mobile"
    >
      <InboxPanelDetails
        :ctx="ctx"
        :p="p"
      />
    </InboxPanelSheet>
    <EvidenceViewer
      :item="p.viewing.value"
      @close="p.viewing.value = null"
    />
  </div>
</template>
