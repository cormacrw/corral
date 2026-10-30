<script setup lang="ts">
import { actionNeedsText, useInboxPanel, type InboxPanelContext } from '~/composables/useInboxPanel'

// Option E, Triage (COR-190, inbox-panel-option-e): almost no text. The
// state, the ask, the artifacts and two big buttons, for review back to
// back: acting moves to the next item, Skip moves on without acting. The
// reply box shows only when an action needs words; the rest is in a drawer.
const props = defineProps<{ ctx: InboxPanelContext, mobile?: boolean }>()
const p = useInboxPanel(props.ctx)
const details = ref(false)
const replying = ref(false)
watch(() => props.ctx.item.id, () => {
  details.value = false
  replying.value = false
})
const showTray = computed(() => p.canAct.value && (replying.value || (props.ctx.action !== null && actionNeedsText(props.ctx.action))))
// Request changes (reviews) or Send back: the second big button
const second = computed(() => p.secondary.value[0] ?? null)
const rest = computed(() => p.secondary.value.slice(1))
</script>

<template>
  <div
    class="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    data-testid="inbox-panel-option-e"
  >
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-default px-3 text-xs text-muted">
      <span v-if="ctx.position">{{ ctx.position.index + 1 }} of {{ ctx.position.total }}</span>
      <span class="truncate">{{ p.item.value.project.name }} · {{ p.item.value.taskRef }}</span>
      <UButton
        label="Details"
        icon="i-lucide-text"
        variant="ghost"
        color="neutral"
        size="xs"
        class="ms-auto"
        data-testid="inbox-details-toggle"
        @click="details = true"
      />
      <UButton
        v-if="ctx.position"
        label="Skip"
        trailing-icon="i-lucide-arrow-right"
        variant="ghost"
        color="neutral"
        size="xs"
        @click="ctx.next"
      />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div :class="['mx-auto flex max-w-xl flex-col items-center gap-4 text-center', mobile ? 'px-4 py-5' : 'px-6 py-10']">
        <UIcon
          :name="p.kind.value.icon"
          :class="['size-10', p.kind.value.color]"
        />
        <div>
          <p class="text-xs font-medium tracking-wide text-muted uppercase">
            {{ p.kind.value.label }}
          </p>
          <h1 class="mt-1 text-xl leading-tight font-semibold text-highlighted">
            {{ p.item.value.subject }}
          </h1>
          <p class="mt-1 text-sm text-muted">
            {{ p.ask.value }}
          </p>
        </div>
        <InboxPanelVerdict
          :p="p"
          class="justify-center"
        />
        <p
          v-if="!p.hasVerdict.value"
          class="line-clamp-3 text-base text-default"
        >
          {{ p.tldr.value }}
        </p>
        <InboxPanelArtifacts
          :p="p"
          :size="mobile ? 'sm' : 'md'"
          :files="false"
          class="justify-center"
        />
        <div
          v-if="p.primary.value"
          :class="['flex w-full gap-3', mobile ? 'flex-col' : 'max-w-md']"
        >
          <UButton
            :label="p.primaryLabel.value"
            :icon="p.primary.value.icon"
            size="xl"
            block
            :loading="ctx.busy && ctx.action === p.primary.value.value"
            data-testid="inbox-primary"
            @click="ctx.act(p.primary.value.value as never)"
          />
          <UButton
            v-if="second"
            :label="second.label"
            :icon="second.icon"
            size="xl"
            block
            color="neutral"
            variant="outline"
            @click="ctx.act(second.value as never)"
          />
        </div>
        <div
          v-if="p.canAct.value"
          class="flex flex-wrap justify-center gap-x-3"
        >
          <UButton
            v-for="a in rest"
            :key="a.value"
            :label="a.label"
            variant="link"
            :color="a.value === 'delete' ? 'error' : 'neutral'"
            size="sm"
            @click="ctx.act(a.value as never)"
          />
          <UButton
            v-if="!showTray"
            label="Reply"
            variant="link"
            color="neutral"
            size="sm"
            @click="replying = true"
          />
        </div>
      </div>
    </div>
    <div
      v-if="showTray"
      class="shrink-0 border-t border-default p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div class="mx-auto max-w-xl">
        <InboxPanelTray :ctx="ctx" />
      </div>
    </div>
    <InboxPanelSheet
      v-model:open="details"
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
