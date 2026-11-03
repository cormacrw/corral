<script setup lang="ts">
import { useCopy } from '~/composables/useCopy'

// The header of a task or an epic, in its three modes (design/task.md). The
// default slot is what names it: a breadcrumb, or the mobile title block,
// which shows Saved itself. `path` is its page, for Copy link and Open full page.
const props = defineProps<{ mode: 'flyout' | 'page' | 'mobile', path: string, saved: boolean }>()
const emit = defineEmits<{ close: [] }>()
const flyout = useTaskFlyout()
const copy = useCopy()
const copyLink = () => copy(`${location.origin}${props.path}`, 'Link copied')
</script>

<template>
  <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
    <template v-if="mode === 'flyout'">
      <AppButton
        v-if="flyout.canGoBack.value"
        icon="i-hugeicons-arrow-left-02"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Back"
        class="-ms-2"
        @click="flyout.back()"
      />
      <slot />
      <span
        v-if="saved"
        class="shrink-0 text-xs text-success"
      >✓ Saved</span>
      <div class="ms-auto flex shrink-0 items-center gap-1">
        <AppTooltip text="Copy link">
          <AppButton
            icon="i-hugeicons-link-01"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Copy link"
            @click="copyLink"
          />
        </AppTooltip>
        <AppTooltip text="Open full page">
          <AppButton
            :to="path"
            icon="i-hugeicons-arrow-expand-01"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Open full page"
          />
        </AppTooltip>
        <AppTooltip text="Close">
          <AppButton
            icon="i-hugeicons-cancel-01"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Close"
            @click="emit('close')"
          />
        </AppTooltip>
      </div>
    </template>
    <template v-else-if="mode === 'mobile'">
      <AppButton
        icon="i-hugeicons-arrow-left-02"
        variant="ghost"
        color="neutral"
        aria-label="Back"
        class="tap-target -ms-2"
        @click="emit('close')"
      />
      <div class="min-w-0 flex-1 leading-tight">
        <slot />
      </div>
      <AppButton
        icon="i-hugeicons-link-01"
        variant="ghost"
        color="neutral"
        aria-label="Copy link"
        class="tap-target"
        @click="copyLink"
      />
      <slot name="actions" />
    </template>
    <template v-else>
      <slot />
      <span
        v-if="saved"
        class="ms-2 shrink-0 text-xs text-success"
      >✓ Saved</span>
    </template>
  </header>
</template>
