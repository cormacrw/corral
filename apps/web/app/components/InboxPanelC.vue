<script setup lang="ts">
import { useInboxPanel, type InboxPanelContext } from '~/composables/useInboxPanel'

// Option C, Checklist (COR-190, inbox-panel-option-c): the acceptance
// criteria are the panel. Each is a row with its evidence thumbnails inline,
// unmet ones first; a row expands for the reviewer's note. The checks, the
// message and the review history are rows of the same list.
const props = defineProps<{ ctx: InboxPanelContext, mobile?: boolean }>()
const p = useInboxPanel(props.ctx)
const expanded = ref<string | null>(null)
watch(() => props.ctx.item.id, () => {
  expanded.value = null
})
const toggle = (id: string) => {
  expanded.value = expanded.value === id ? null : id
}
const rows = computed(() => p.criteria.value.toSorted((a, b) => Number(a.met !== false) - Number(b.met !== false)))
const thumbs = (evidence: typeof p.images.value) => evidence.filter(e => p.images.value.includes(e))
</script>

<template>
  <div
    class="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    data-testid="inbox-panel-option-c"
  >
    <header :class="['flex shrink-0 gap-3 border-b border-default', mobile ? 'flex-col p-3' : 'items-center px-4 py-3']">
      <div class="min-w-0 flex-1">
        <InboxPanelMeta
          :p="p"
          kind
        />
        <h1 :class="['font-semibold text-highlighted', mobile ? 'text-lg leading-tight' : 'truncate text-base']">
          {{ p.item.value.subject }}
        </h1>
        <p class="text-sm text-muted">
          {{ p.ask.value }}
        </p>
      </div>
      <InboxPanelActions
        :ctx="ctx"
        :p="p"
        :size="mobile ? 'md' : 'sm'"
        :class="!mobile && 'shrink-0 justify-end'"
      />
    </header>
    <div :class="['min-h-0 flex-1 overflow-y-auto overscroll-contain', mobile ? 'p-3' : 'p-4']">
      <ul class="mx-auto flex max-w-[760px] flex-col divide-y divide-default rounded-lg border border-default">
        <!-- Checks: the verdict and the links -->
        <li
          v-if="p.hasVerdict.value || p.pr.value || p.preview.value"
          class="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5"
        >
          <InboxPanelVerdict :p="p" />
          <InboxPanelArtifacts
            :p="p"
            :files="false"
            class="ms-auto [&>button]:hidden"
          />
        </li>
        <li
          v-for="c in rows"
          :key="c.id"
        >
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2 text-start hover:bg-elevated/50"
            :aria-expanded="expanded === c.id"
            @click="toggle(c.id)"
          >
            <UIcon
              :name="c.met ? 'i-lucide-circle-check' : c.met === false ? 'i-lucide-circle-x' : 'i-lucide-circle'"
              :class="['size-5 shrink-0', c.met ? 'text-success' : c.met === false ? 'text-error' : 'text-dimmed']"
            />
            <span :class="['min-w-0 flex-1 text-sm', mobile ? 'line-clamp-2' : 'truncate', c.met === false && 'text-error']">{{ c.text.replaceAll('`', '') }}</span>
            <span class="flex shrink-0 items-center gap-1">
              <span
                v-for="e in thumbs(c.evidence).slice(0, mobile ? 1 : 2)"
                :key="e.id"
                role="button"
                tabindex="0"
                :class="['overflow-hidden rounded border border-default hover:ring-2 hover:ring-primary', mobile ? 'h-9 w-14' : 'h-10 w-16']"
                :aria-label="`Open ${e.fileName}`"
                @click.stop="p.viewing.value = e"
                @keydown.enter.stop="p.viewing.value = e"
              >
                <img
                  :src="e.url ?? undefined"
                  alt=""
                  class="size-full object-cover object-top"
                >
              </span>
              <UIcon
                v-if="c.evidence.length > thumbs(c.evidence).slice(0, mobile ? 1 : 2).length"
                :name="c.evidence.some(e => e.kind === 'note') ? 'i-lucide-sticky-note' : 'i-lucide-file-text'"
                class="size-4 text-muted"
              />
            </span>
            <UIcon
              :name="expanded === c.id ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="size-4 shrink-0 text-dimmed"
            />
          </button>
          <div
            v-if="expanded === c.id"
            class="flex flex-col gap-2 px-3 pb-3 ps-11 text-sm"
          >
            <p
              v-if="c.note"
              class="text-muted"
            >
              <span class="font-medium text-default">{{ p.task.value?.reviewer?.name ?? 'Reviewer' }}:</span> {{ c.note }}
            </p>
            <EvidenceGroup
              :evidence="c.evidence"
              @open="p.viewing.value = $event"
            />
          </div>
        </li>
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2.5 text-start hover:bg-elevated/50"
            :aria-expanded="expanded === 'message'"
            data-testid="inbox-details-toggle"
            @click="toggle('message')"
          >
            <UIcon
              name="i-lucide-text"
              class="size-5 shrink-0 text-muted"
            />
            <span class="min-w-0 flex-1 text-sm">
              <span class="font-medium">{{ p.item.value.sender.name }}</span>
              <span :class="['text-muted', expanded === 'message' ? 'hidden' : 'line-clamp-2']"> {{ p.tldr.value }}</span>
            </span>
            <UIcon
              :name="expanded === 'message' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="size-4 shrink-0 text-dimmed"
            />
          </button>
          <div
            v-if="expanded === 'message'"
            class="px-3 pb-3 ps-11"
          >
            <InboxPanelDetails
              :ctx="ctx"
              :p="p"
              section="message"
            />
          </div>
        </li>
        <li v-if="p.history.value.length">
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2.5 text-start hover:bg-elevated/50"
            :aria-expanded="expanded === 'history'"
            @click="toggle('history')"
          >
            <UIcon
              name="i-lucide-history"
              class="size-5 shrink-0 text-muted"
            />
            <span class="min-w-0 flex-1 text-sm">Review history <span class="text-muted">· {{ p.history.value.length }} {{ p.history.value.length === 1 ? 'round' : 'rounds' }}</span></span>
            <UIcon
              :name="expanded === 'history' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="size-4 shrink-0 text-dimmed"
            />
          </button>
          <div
            v-if="expanded === 'history'"
            class="px-3 pb-3 ps-11"
          >
            <InboxPanelDetails
              :ctx="ctx"
              :p="p"
              section="history"
            />
          </div>
        </li>
        <li
          v-if="p.files.value.some(e => e.criterionId === null)"
          class="flex items-center gap-3 px-3 py-2.5 text-sm"
        >
          <UIcon
            name="i-lucide-paperclip"
            class="size-5 shrink-0 text-muted"
          />
          <span class="flex-1 text-muted">Task as a whole</span>
          <UButton
            v-for="e in p.files.value.filter(x => x.criterionId === null)"
            :key="e.id"
            :label="e.fileName ?? 'File'"
            variant="ghost"
            color="neutral"
            size="xs"
            @click="p.viewing.value = e"
          />
        </li>
      </ul>
    </div>
    <div
      v-if="p.canAct.value"
      class="shrink-0 border-t border-default p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div class="mx-auto max-w-[760px]">
        <InboxPanelTray :ctx="ctx" />
      </div>
    </div>
    <EvidenceViewer
      :item="p.viewing.value"
      @close="p.viewing.value = null"
    />
  </div>
</template>
