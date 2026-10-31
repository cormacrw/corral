<script setup lang="ts">
import type { EpicConflictItem } from '@corral/contracts'
import { api } from '~/composables/useApi'

const props = defineProps<{ item: EpicConflictItem }>()
const emit = defineEmits<{ resolved: [] }>()
const busy = ref(false)
const error = ref<string | null>(null)
async function handOff() {
  busy.value = true
  error.value = null
  try {
    await api.epics.review(props.item.epicId, { action: 'rebase', headSha: props.item.headSha })
    emit('resolved')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    aria-label="Epic PR conflict"
  >
    <InboxEpicHeader
      badge="Epic conflict · Needs you"
      color="error"
      :title="item.subject"
      :epic-id="item.epicId"
      :pr-url="item.prUrl"
      pr-label="Open epic PR"
    >
      {{ item.project.name }} · the target branch {{ item.targetBranch }} is unchanged
    </InboxEpicHeader>
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
      <InboxMessage
        v-if="item.message"
        :key="item.id"
        :item="item"
      />
      <p
        v-else
        class="break-words"
      >
        The epic PR can't rebase onto {{ item.targetBranch }}.
      </p>
      <section
        v-if="item.files.length"
        aria-label="Conflicting files"
        class="rounded-lg border border-default"
      >
        <h2 class="border-b border-default px-3 py-2 text-xs font-medium text-muted">
          {{ item.files.length }} conflicting {{ item.files.length === 1 ? 'file' : 'files' }}
        </h2>
        <ul class="divide-y divide-default">
          <li
            v-for="file in item.files"
            :key="file"
            class="flex gap-2 px-3 py-2 font-mono text-sm break-all"
          >
            <UIcon
              name="i-lucide-file-warning"
              class="mt-0.5 size-4 shrink-0 text-error"
            />
            {{ file }}
          </li>
        </ul>
      </section>
      <p
        v-else
        class="text-muted"
      >
        Corral couldn't work out which files conflict; the PR on GitHub shows them.
      </p>
    </div>
    <footer class="space-y-3 border-t border-default p-4">
      <UAlert
        v-if="error"
        :title="error"
        color="error"
      />
      <p class="text-xs text-muted">
        A developer rebases the epic branch and force-pushes it. The epic PR then goes back to agent review, and to you.
      </p>
      <UButton
        label="Hand the rebase to a developer"
        icon="i-lucide-git-branch"
        :loading="busy"
        class="justify-center max-sm:min-h-11 max-sm:w-full"
        @click="handOff"
      />
    </footer>
  </section>
</template>
