<script setup lang="ts">
import type { GuideHunk } from '~/features/inbox/utils/guide'
import { diffLineClass } from '~/features/inbox/utils/guide'

// One hunk of a guide step (COR-518, design): its file, a way to the same file
// in Files, and its lines. On a phone the lines wrap, so neither the hunk nor
// the page scrolls sideways; on a wide screen they keep their shape and the
// hunk scrolls inside its box.
defineProps<{ hunk: GuideHunk, mobile?: boolean, githubUrl: string }>()
defineEmits<{ openFile: [path: string] }>()
</script>

<template>
  <div
    class="overflow-hidden rounded-md border border-border"
    data-testid="inbox-guide-hunk"
  >
    <div class="flex items-center gap-2 bg-muted/50 py-1 ps-3 pe-1 text-xs">
      <span
        class="min-w-0 flex-1 truncate text-left font-mono"
        dir="rtl"
        :title="hunk.path"
      ><bdi>{{ hunk.path }}</bdi></span>
      <AppButton
        v-if="hunk.lines"
        label="In Files"
        trailing-icon="i-hugeicons-arrow-right-02"
        variant="ghost"
        color="neutral"
        size="xs"
        :title="`Show ${hunk.path} in Files`"
        @click="$emit('openFile', hunk.path)"
      />
    </div>
    <div
      v-if="hunk.lines"
      :class="['border-t border-border font-mono text-xs/5', mobile ? '' : 'overflow-x-auto']"
    >
      <div
        v-for="(line, i) in hunk.lines"
        :key="i"
        :class="['px-3', mobile ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'min-w-max whitespace-pre', diffLineClass(line)]"
        v-text="line || ' '"
      />
    </div>
    <div
      v-else
      class="flex flex-wrap items-center gap-x-2 border-t border-border px-3 py-2 text-sm text-muted-foreground"
      data-testid="inbox-guide-hunk-cut"
    >
      <Icon
        name="i-hugeicons-scissor-01"
        class="size-4 shrink-0 text-warning"
      />
      <span>Past the diff's cap, so not shown here.</span>
      <AppButton
        :to="githubUrl"
        target="_blank"
        label="See it on GitHub"
        trailing-icon="i-hugeicons-arrow-up-right-01"
        variant="link"
        color="neutral"
        size="sm"
        class="px-0"
      />
    </div>
  </div>
</template>
