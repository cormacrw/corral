<script setup lang="ts">
import type { PullRequestDetail } from '@corral/contracts'
import { PULL_REQUEST_LINE_LIMIT } from '@corral/contracts/client'
import { plural } from '~/utils/labels'

// A PR's diff in the Inbox (design/inbox.md, the Code diff tab): the changed
// files with their line counts, each opening to its unified diff. The first
// file starts open; a diff over the server's cap says so and links to the rest.
// `githubUrl` replaces the PR's files page, for a diff that isn't the whole PR
// `focus` opens a file and scrolls to it, for a guide step's "In Files"
const props = defineProps<{ pr: PullRequestDetail, githubUrl?: string, focus?: string | null }>()
const github = computed(() => props.githubUrl ?? `${props.pr.url}/files`)
const open = ref<string[]>([])
watch(() => props.pr.number, () => {
  open.value = props.pr.files.slice(0, 1).map(f => f.path)
}, { immediate: true })
const root = ref<HTMLElement | null>(null)
watch(() => props.focus, async (path) => {
  if (!path) return
  if (!open.value.includes(path)) open.value = [...open.value, path]
  await nextTick()
  root.value?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start' })
}, { immediate: true })
const toggle = (path: string) => {
  open.value = open.value.includes(path) ? open.value.filter(p => p !== path) : [...open.value, path]
}
const additions = computed(() => props.pr.files.reduce((n, f) => n + f.additions, 0))
const deletions = computed(() => props.pr.files.reduce((n, f) => n + f.deletions, 0))
// The cap is on files and on changed lines, so every file can be here with the
// last one cut
const shown = computed(() => {
  const { files, totalFiles } = props.pr
  return files.length < totalFiles ? `Showing ${files.length} of ${plural(totalFiles, 'file')}` : `Showing all ${plural(totalFiles, 'file')}, the last one cut`
})
const lineClass = (line: string) => line.startsWith('@@')
  ? 'bg-muted text-muted-foreground'
  : line.startsWith('+') ? 'bg-success/10 text-foreground' : line.startsWith('-') ? 'bg-destructive/10 text-foreground' : 'text-muted-foreground'
</script>

<template>
  <div
    ref="root"
    class="flex flex-col gap-3"
    data-testid="inbox-diff"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span>{{ plural(pr.totalFiles, 'file') }}</span>
      <template v-if="!pr.truncated">
        <span class="text-success">+{{ additions }}</span>
        <span class="text-destructive">−{{ deletions }}</span>
      </template>
      <span class="min-w-0 truncate">{{ pr.headBranch }} → {{ pr.baseBranch }}</span>
      <AppButton
        :to="github"
        target="_blank"
        label="Open on GitHub"
        trailing-icon="i-hugeicons-arrow-up-right-01"
        variant="link"
        color="neutral"
        size="sm"
        class="ms-auto px-0"
      />
    </div>
    <AppAlert
      v-if="pr.truncated"
      color="warning"
      variant="subtle"
      icon="i-hugeicons-scissor-01"
      :title="`${shown}, up to ${PULL_REQUEST_LINE_LIMIT.toLocaleString('en')} changed lines`"
      :actions="[{ label: 'See the full diff on GitHub', to: github, target: '_blank', trailingIcon: 'i-hugeicons-arrow-up-right-01' }]"
      data-testid="inbox-diff-truncated"
    />
    <div
      v-for="file in pr.files"
      :key="file.path"
      :data-path="file.path"
      :class="['scroll-mt-2 overflow-hidden rounded-md border', file.path === focus ? 'border-primary/50' : 'border-border']"
      data-testid="inbox-diff-file"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 bg-muted/50 px-3 py-2 text-start text-sm hover:bg-muted"
        :aria-expanded="open.includes(file.path)"
        @click="toggle(file.path)"
      >
        <Icon
          :name="open.includes(file.path) ? 'i-hugeicons-arrow-down-01' : 'i-hugeicons-arrow-right-01'"
          class="size-4 shrink-0 text-muted-foreground/70"
        />
        <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ file.path }}</span>
        <span
          v-if="file.status !== 'modified'"
          class="text-xs text-muted-foreground"
        >{{ file.status }}</span>
        <span class="shrink-0 font-mono text-xs"><span class="text-success">+{{ file.additions }}</span> <span class="text-destructive">−{{ file.deletions }}</span></span>
      </button>
      <template v-if="open.includes(file.path)">
        <div
          v-if="file.patch"
          class="overflow-x-auto border-t border-border font-mono text-xs/5"
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
          class="border-t border-border px-3 py-2 text-sm text-muted-foreground"
        >
          No text diff for this file. It may be binary or very large.
        </p>
      </template>
    </div>
  </div>
</template>
