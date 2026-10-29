<script setup lang="ts">
import { highlight, mobileSearch } from '~/utils/search'
import { timeAgo } from '~/utils/labels'

// The mobile Search screen (design/mobile.md): the web's command palette as
// a full screen over the shell, opened from the header's search button.
// Picking a result goes to it and closes the screen.
const open = defineModel<boolean>('open', { required: true })
const state = useLive().state
const query = ref('')
// Each search starts empty; the input focuses itself as the screen opens
watch(open, (isOpen) => {
  if (isOpen) query.value = ''
})

const projectName = (id: string) => state.value.projects.find(p => p.id === id)?.name ?? ''
const results = computed(() => mobileSearch(query.value, {
  projects: state.value.projects,
  agents: state.value.agents,
  tasks: Object.values(state.value.tasks).flat(),
  epics: Object.values(state.value.epics).flat(),
  planSessions: state.value.planSessions
}))
const empty = computed(() => Object.values(results.value).every(group => group.length === 0))
const parts = (text: string) => highlight(text, query.value)

async function go(to: string) {
  open.value = false
  await navigateTo(to)
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex flex-col bg-default pt-[env(safe-area-inset-top)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]"
    role="dialog"
    aria-modal="true"
    aria-label="Search"
    data-testid="mobile-search"
    @keydown.esc="open = false"
  >
    <div class="flex h-14 shrink-0 items-center gap-2 border-b border-default ps-2 pe-1">
      <UInput
        v-model="query"
        icon="i-lucide-search"
        placeholder="Search pages and tasks…"
        aria-label="Search pages and tasks"
        size="lg"
        class="flex-1"
        :ui="{ base: 'ring-2 ring-primary' }"
        autofocus
      />
      <UButton
        label="Cancel"
        variant="ghost"
        color="neutral"
        @click="open = false"
      />
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
      <p
        v-if="empty"
        class="p-6 text-center text-sm text-muted"
      >
        Nothing matches “{{ query.trim() }}”.
      </p>

      <section v-if="results.pages.length">
        <h2 class="px-4 pt-4 pb-2 text-sm font-semibold text-highlighted">
          Go to
        </h2>
        <ul class="divide-y divide-default border-y border-default">
          <li
            v-for="page in results.pages"
            :key="page.to"
          >
            <button
              type="button"
              class="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-start active:bg-elevated"
              @click="go(page.to)"
            >
              <UIcon
                :name="page.icon"
                class="size-4 shrink-0 text-muted"
              />
              <span class="min-w-0 flex-1 truncate">{{ parts(page.label).before }}<b>{{ parts(page.label).match }}</b>{{ parts(page.label).after }}</span>
            </button>
          </li>
        </ul>
      </section>

      <section v-if="results.epics.length">
        <h2 class="px-4 pt-4 pb-2 text-sm font-semibold text-highlighted">
          Epics
        </h2>
        <ul class="divide-y divide-default border-y border-default">
          <li
            v-for="epic in results.epics"
            :key="epic.id"
          >
            <button
              type="button"
              class="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-start active:bg-elevated"
              @click="go(`/epics/${epic.id}`)"
            >
              <UIcon
                name="i-lucide-network"
                class="size-4 shrink-0 text-muted"
              />
              <span class="min-w-0 flex-1 truncate">{{ parts(epic.title).before }}<b>{{ parts(epic.title).match }}</b>{{ parts(epic.title).after }}</span>
              <span class="shrink-0 text-xs text-muted">{{ projectName(epic.projectId) }} · {{ epic.mergedCount }} of {{ epic.taskCount }} merged</span>
            </button>
          </li>
        </ul>
      </section>

      <section v-if="results.tasks.length">
        <h2 class="px-4 pt-4 pb-2 text-sm font-semibold text-highlighted">
          Tasks
        </h2>
        <ul class="divide-y divide-default border-y border-default">
          <li
            v-for="t in results.tasks"
            :key="t.id"
          >
            <button
              type="button"
              class="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-start active:bg-elevated"
              :data-testid="`search-task-${t.ref}`"
              @click="go(`/tasks/${t.ref}`)"
            >
              <span class="w-14 shrink-0 font-mono text-xs text-muted">{{ t.ref }}</span>
              <span class="min-w-0 flex-1 truncate">{{ parts(t.title).before }}<b>{{ parts(t.title).match }}</b>{{ parts(t.title).after }}</span>
              <StatusBadge
                :status="t.status"
                size="xs"
              />
            </button>
          </li>
        </ul>
      </section>

      <section v-if="results.sessions.length">
        <h2 class="px-4 pt-4 pb-2 text-sm font-semibold text-highlighted">
          Plan sessions
        </h2>
        <ul class="divide-y divide-default border-y border-default">
          <li
            v-for="session in results.sessions"
            :key="session.id"
          >
            <button
              type="button"
              class="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-start active:bg-elevated"
              @click="go(`/plan/${session.id}`)"
            >
              <UIcon
                name="i-lucide-message-square"
                class="size-4 shrink-0 text-muted"
              />
              <span class="min-w-0 flex-1 truncate">{{ parts(session.title).before }}<b>{{ parts(session.title).match }}</b>{{ parts(session.title).after }}</span>
              <span class="shrink-0 text-xs text-muted">{{ timeAgo(session.updatedAt) }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
