<script setup lang="ts">
import type { RunEvent } from '@corral/contracts'

// The transcript log (design/agent.md): system dividers, agent messages,
// tool call cards with their output, and a working line while live
const props = defineProps<{ events: RunEvent[], live: boolean, agentName: string }>()

interface Entry {
  key: number
  type: 'system' | 'message' | 'tool'
  text?: string
  tool?: string
  input?: unknown
  output?: string
  isError?: boolean
}

const entries = computed<Entry[]>(() => {
  const list: Entry[] = []
  const byId = new Map<string, Entry>()
  props.events.forEach((event, i) => {
    switch (event.type) {
      case 'system':
        list.push({ key: i, type: 'system', text: event.text })
        break
      case 'message':
        list.push({ key: i, type: 'message', text: event.text })
        break
      case 'tool_call': {
        const entry: Entry = { key: i, type: 'tool', tool: event.tool.replace(/^mcp__corral__/, ''), input: event.input }
        list.push(entry)
        byId.set(event.id, entry)
        break
      }
      case 'tool_result': {
        const entry = byId.get(event.id)
        if (entry) {
          entry.output = event.output
          entry.isError = event.isError
        }
        break
      }
      default:
        break
    }
  })
  return list
})

function target(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const value = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.query ?? o.url ?? o.outcome ?? o.body ?? ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}
const expanded = ref(new Set<number>())
const toggle = (key: number) => {
  if (expanded.value.has(key)) expanded.value.delete(key)
  else expanded.value.add(key)
}
const log = ref<HTMLElement | null>(null)
watch(() => props.events.length, async () => {
  await nextTick()
  if (props.live && log.value) log.value.scrollTop = log.value.scrollHeight
})
</script>

<template>
  <div
    ref="log"
    role="log"
    aria-live="polite"
    class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
  >
    <div class="mx-auto flex w-full max-w-[880px] flex-col gap-3">
      <template v-for="entry in entries">
        <div
          v-if="entry.type === 'system'"
          :key="`s${entry.key}`"
          class="flex items-center gap-2 text-xs text-muted"
        >
          <span class="h-px flex-1 bg-border" />
          <span class="max-w-[80%] truncate">{{ entry.text }}</span>
          <span class="h-px flex-1 bg-border" />
        </div>
        <MarkdownText
          v-else-if="entry.type === 'message'"
          :key="`m${entry.key}`"
          :text="entry.text ?? ''"
          class="text-sm text-highlighted"
        />
        <div
          v-else
          :key="`t${entry.key}`"
          class="overflow-hidden rounded-md border border-default text-xs"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 bg-muted px-2 py-1.5 text-start"
            :aria-expanded="expanded.has(entry.key)"
            @click="toggle(entry.key)"
          >
            <UBadge
              :label="entry.tool"
              variant="subtle"
              :color="entry.isError ? 'error' : 'neutral'"
              size="xs"
            />
            <span class="min-w-0 flex-1 truncate font-mono text-muted">{{ target(entry.input) }}</span>
            <UIcon
              :name="expanded.has(entry.key) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="size-3.5 text-dimmed"
            />
          </button>
          <div
            v-if="expanded.has(entry.key)"
            class="flex flex-col gap-2 p-2"
          >
            <pre class="max-h-60 overflow-auto rounded bg-elevated p-2 font-mono whitespace-pre-wrap">{{ JSON.stringify(entry.input, null, 2) }}</pre>
            <pre
              v-if="entry.output !== undefined"
              :class="['max-h-80 overflow-auto rounded p-2 font-mono whitespace-pre-wrap', entry.isError ? 'bg-error/10 text-error' : 'bg-elevated']"
            >{{ entry.output }}</pre>
          </div>
        </div>
      </template>
      <p
        v-if="props.live"
        class="flex items-center gap-2 text-sm text-muted"
      >
        <span class="relative flex size-2">
          <span class="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75 motion-reduce:hidden" />
          <span class="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
        {{ props.agentName }} is working…
      </p>
      <p
        v-if="entries.length === 0 && !props.live"
        class="text-sm text-muted"
      >
        No transcript.
      </p>
    </div>
  </div>
</template>
