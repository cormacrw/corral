<script setup lang="ts">
import { PULL_REQUEST_LINE_LIMIT, type PullRequestDetail } from '@corral/contracts'

// A PR's diff in the Inbox (design/inbox.md, the Code diff tab): the changed
// files with their line counts, each opening to its unified diff. The first
// file starts open; a diff over the server's cap says so and links to the rest.
const props = defineProps<{ pr: PullRequestDetail }>()
const open = ref<string[]>([])
watch(() => props.pr.number, () => {
  open.value = props.pr.files.slice(0, 1).map(f => f.path)
}, { immediate: true })
const toggle = (path: string) => {
  open.value = open.value.includes(path) ? open.value.filter(p => p !== path) : [...open.value, path]
}
const additions = computed(() => props.pr.files.reduce((n, f) => n + f.additions, 0))
const deletions = computed(() => props.pr.files.reduce((n, f) => n + f.deletions, 0))
const plural = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`
// The cap is on files and on changed lines, so every file can be here with the
// last one cut
const shown = computed(() => {
  const { files, totalFiles } = props.pr
  return files.length < totalFiles ? `Showing ${files.length} of ${plural(totalFiles)}` : `Showing all ${plural(totalFiles)}, the last one cut`
})
const lineClass = (line: string) => line.startsWith('@@')
  ? 'bg-elevated text-muted'
  : line.startsWith('+') ? 'bg-success/10 text-default' : line.startsWith('-') ? 'bg-error/10 text-default' : 'text-muted'
</script>

<template>
  <div
    class="flex flex-col gap-3"
    data-testid="inbox-diff"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <span>{{ plural(pr.totalFiles) }}</span>
      <template v-if="!pr.truncated">
        <span class="text-success">+{{ additions }}</span>
        <span class="text-error">−{{ deletions }}</span>
      </template>
      <span class="min-w-0 truncate">{{ pr.headBranch }} → {{ pr.baseBranch }}</span>
      <UButton
        :to="`${pr.url}/files`"
        target="_blank"
        label="Open on GitHub"
        trailing-icon="i-lucide-arrow-up-right"
        variant="link"
        color="neutral"
        size="sm"
        class="ms-auto px-0"
      />
    </div>
    <UAlert
      v-if="pr.truncated"
      color="warning"
      variant="subtle"
      icon="i-lucide-scissors"
      :title="`${shown}, up to ${PULL_REQUEST_LINE_LIMIT.toLocaleString('en')} changed lines`"
      :actions="[{ label: 'See the full diff on GitHub', to: `${pr.url}/files`, target: '_blank', trailingIcon: 'i-lucide-arrow-up-right' }]"
      data-testid="inbox-diff-truncated"
    />
    <div
      v-for="file in pr.files"
      :key="file.path"
      class="overflow-hidden rounded-md border border-default"
      data-testid="inbox-diff-file"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 bg-elevated/50 px-3 py-2 text-start text-sm hover:bg-elevated"
        :aria-expanded="open.includes(file.path)"
        @click="toggle(file.path)"
      >
        <UIcon
          :name="open.includes(file.path) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-4 shrink-0 text-dimmed"
        />
        <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ file.path }}</span>
        <span
          v-if="file.status !== 'modified'"
          class="text-xs text-muted"
        >{{ file.status }}</span>
        <span class="shrink-0 font-mono text-xs"><span class="text-success">+{{ file.additions }}</span> <span class="text-error">−{{ file.deletions }}</span></span>
      </button>
      <template v-if="open.includes(file.path)">
        <div
          v-if="file.patch"
          class="overflow-x-auto border-t border-default font-mono text-xs/5"
        >
          <div
            v-for="(line, i) in file.patch.split('\n')"
            :key="i"
            :class="['min-w-max px-3 whitespace-pre', lineClass(line)]"
            v-text="line || ' '"
          />
        </div>
        <p
          v-else
          class="border-t border-default px-3 py-2 text-sm text-muted"
        >
          No text diff for this file. It may be binary or very large.
        </p>
      </template>
    </div>
  </div>
</template>
