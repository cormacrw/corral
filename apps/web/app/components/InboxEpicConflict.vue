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
    <header class="border-b border-default p-4">
      <UBadge
        label="Epic conflict · Needs you"
        color="error"
        variant="subtle"
      />
      <h1 class="mt-2 text-lg font-semibold">
        {{ item.subject }}
      </h1>
      <p class="text-xs text-muted">
        {{ item.project.name }} · the target branch {{ item.targetBranch }} is unchanged
      </p>
    </header>
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <p>The epic PR can't rebase onto {{ item.targetBranch }}.</p>
      <ul
        v-if="item.files.length"
        class="space-y-1"
        aria-label="Conflicting files"
      >
        <li
          v-for="file in item.files"
          :key="file"
          class="font-mono text-sm break-all"
        >
          {{ file }}
        </li>
      </ul>
      <p
        v-else
        class="text-muted"
      >
        Corral couldn't work out which files conflict; the PR on GitHub shows them.
      </p>
      <a
        :href="item.prUrl"
        target="_blank"
        rel="noopener"
        class="text-primary hover:underline"
      >Open epic PR</a>
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
        @click="handOff"
      />
    </footer>
  </section>
</template>
