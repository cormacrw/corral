<script setup lang="ts">
import type { RunEvent } from '@corral/contracts'
import { summarizeSteps, transcriptEntries, type ToolStep } from '~/utils/tool-steps'

// The transcript log (design/agent.md): system dividers, agent messages,
// muted "Thinking" steps, collapsed groups of tool steps, and a working line
// while live. `inline` drops its own scrolling log so it can sit inside
// another one, like Plan's. `mine` are the texts of mid-run messages you
// sent, shown as your bubbles rather than the agent's words.
const props = defineProps<{ events: RunEvent[], live: boolean, agentName: string, inline?: boolean, working?: string, mine?: string[] }>()
const isMine = (text: string) => props.mine?.includes(text.trim()) ?? false

const OUTPUT_LINES = 12

const entries = computed(() => transcriptEntries(props.events).map((entry) => {
  if (entry.type !== 'steps') return entry
  const failed = entry.steps.filter(s => s.isError).length
  const running = props.live && entry.steps.some(s => !s.done)
  return { ...entry, summary: summarizeSteps(entry.steps), failed, running }
}))

// Groups and steps start closed unless something in them failed; a click
// overrides that either way
const toggled = ref(new Map<string, boolean>())
const isOpen = (key: string, byDefault: boolean) => toggled.value.get(key) ?? byDefault
const toggle = (key: string, byDefault: boolean) => toggled.value.set(key, !isOpen(key, byDefault))

function shownOutput(step: ToolStep): string {
  const lines = (step.output ?? '').trimEnd().split('\n')
  if (lines.length <= OUTPUT_LINES || isOpen(`full${step.key}`, false)) return lines.join('\n')
  return lines.slice(-OUTPUT_LINES).join('\n')
}
const outputLines = (step: ToolStep) => (step.output ?? '').trimEnd().split('\n').length

const log = ref<HTMLElement | null>(null)
watch(() => props.events.length, async () => {
  await nextTick()
  if (props.live && log.value && !props.inline) log.value.scrollTop = log.value.scrollHeight
})
</script>

<template>
  <div
    ref="log"
    :role="props.inline ? undefined : 'log'"
    :aria-live="props.inline ? undefined : 'polite'"
    :class="props.inline ? 'flex flex-col gap-3' : 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4'"
  >
    <div :class="['flex w-full flex-col gap-3', !props.inline && 'mx-auto max-w-[880px]']">
      <template v-for="entry in entries">
        <div
          v-if="entry.type === 'system'"
          :key="`s${entry.key}`"
          class="flex items-center gap-2 text-xs text-muted"
        >
          <span class="h-px flex-1 bg-border" />
          <TaskRefText
            :text="entry.text"
            class="max-w-[80%] truncate"
          />
          <span class="h-px flex-1 bg-border" />
        </div>
        <div
          v-else-if="entry.type === 'message' && isMine(entry.text)"
          :key="`y${entry.key}`"
          class="flex max-w-[80%] min-w-0 flex-col items-end gap-1 self-end"
          data-testid="mid-run-message"
        >
          <span class="text-xs text-muted">You, mid-run</span>
          <MarkdownText
            :text="entry.text"
            class="rounded-lg bg-elevated px-3 py-2 text-sm text-highlighted"
          />
        </div>
        <MarkdownText
          v-else-if="entry.type === 'message'"
          :key="`m${entry.key}`"
          :text="entry.text"
          class="text-sm text-highlighted"
        />
        <div
          v-else-if="entry.type === 'thinking' && !entry.text"
          :key="`t${entry.key}`"
          class="flex items-center gap-2 self-start py-1 ps-1 pe-2 text-sm text-dimmed italic"
        >
          <UIcon
            name="i-lucide-brain"
            class="size-3.5 shrink-0"
          />
          Thinking
        </div>
        <div
          v-else-if="entry.type === 'thinking'"
          :key="`t${entry.key}`"
          class="flex flex-col"
        >
          <button
            type="button"
            class="flex items-center gap-2 self-start rounded-md py-1 ps-1 pe-2 text-start text-sm text-dimmed italic hover:bg-elevated"
            :aria-expanded="isOpen(`t${entry.key}`, false)"
            @click="toggle(`t${entry.key}`, false)"
          >
            <UIcon
              :name="isOpen(`t${entry.key}`, false) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              class="size-3.5 shrink-0"
            />
            Thinking
          </button>
          <TaskRefText
            v-if="isOpen(`t${entry.key}`, false)"
            class="ms-2.5 border-s border-default ps-3.5 text-sm wrap-anywhere whitespace-pre-wrap text-muted"
            :text="entry.text"
          />
        </div>
        <div
          v-else
          :key="`g${entry.key}`"
          class="flex flex-col"
        >
          <button
            type="button"
            class="flex max-w-full items-center gap-2 self-start rounded-md py-1 ps-1 pe-2 text-start text-sm text-muted hover:bg-elevated"
            :aria-expanded="isOpen(`g${entry.key}`, entry.failed > 0)"
            @click="toggle(`g${entry.key}`, entry.failed > 0)"
          >
            <UIcon
              :name="isOpen(`g${entry.key}`, entry.failed > 0) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              class="size-3.5 shrink-0 text-dimmed"
            />
            <span class="min-w-0 truncate">{{ entry.summary }}</span>
            <UBadge
              v-if="entry.failed > 0"
              :label="`${entry.failed} failed`"
              icon="i-lucide-x"
              color="error"
              variant="subtle"
              size="sm"
              class="shrink-0 rounded-full"
            />
            <UBadge
              v-else-if="entry.running"
              label="Running"
              icon="i-lucide-loader-circle"
              color="primary"
              variant="subtle"
              size="sm"
              class="shrink-0 rounded-full"
              :ui="{ leadingIcon: 'animate-spin motion-reduce:animate-none' }"
            />
            <UBadge
              v-else
              :label="entry.steps.length === 1 ? '1 step' : `${entry.steps.length} steps`"
              color="neutral"
              variant="soft"
              size="sm"
              class="shrink-0 rounded-full"
            />
          </button>
          <div
            v-if="isOpen(`g${entry.key}`, entry.failed > 0)"
            class="ms-2.5 flex flex-col border-s border-default ps-3.5"
          >
            <div
              v-for="step in entry.steps"
              :key="step.key"
              class="flex flex-col"
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded px-1 py-1 text-start text-sm hover:bg-elevated"
                :aria-expanded="isOpen(`s${step.key}`, step.isError)"
                @click="toggle(`s${step.key}`, step.isError)"
              >
                <span :class="['shrink-0 font-medium', step.isError ? 'text-error' : 'text-default']">{{ step.verb }}</span>
                <span :class="['min-w-0 truncate text-muted', step.kind === 'phrase' ? 'text-sm' : 'font-mono text-xs']">{{ step.target }}</span>
                <span
                  v-if="step.added !== undefined"
                  class="shrink-0 font-mono text-xs text-success"
                >+{{ step.added }}</span>
                <span
                  v-if="step.removed !== undefined"
                  class="shrink-0 font-mono text-xs text-error"
                >−{{ step.removed }}</span>
                <UIcon
                  v-if="props.live && !step.done"
                  name="i-lucide-loader-circle"
                  class="size-3.5 shrink-0 animate-spin text-dimmed motion-reduce:animate-none"
                />
              </button>
              <div
                v-if="isOpen(`s${step.key}`, step.isError)"
                class="mb-2 flex flex-col gap-1 ps-1"
              >
                <pre
                  v-if="step.output"
                  :class="['max-h-80 overflow-auto overscroll-contain rounded-md p-2 font-mono text-xs/5 wrap-anywhere whitespace-pre-wrap', step.isError ? 'bg-error/10 text-error' : 'bg-elevated text-default']"
                ><TaskRefText :text="shownOutput(step)" /></pre>
                <div class="flex gap-3 text-xs">
                  <UButton
                    v-if="outputLines(step) > OUTPUT_LINES"
                    :label="isOpen(`full${step.key}`, false) ? `Last ${OUTPUT_LINES} lines` : `All ${outputLines(step)} lines`"
                    variant="link"
                    color="neutral"
                    size="xs"
                    class="px-0"
                    @click="toggle(`full${step.key}`, false)"
                  />
                  <UButton
                    :label="isOpen(`raw${step.key}`, false) ? 'Hide raw input' : 'Raw input'"
                    variant="link"
                    color="neutral"
                    size="xs"
                    class="px-0"
                    @click="toggle(`raw${step.key}`, false)"
                  />
                </div>
                <pre
                  v-if="isOpen(`raw${step.key}`, false)"
                  class="max-h-60 overflow-auto overscroll-contain rounded-md bg-elevated p-2 font-mono text-xs/5 wrap-anywhere whitespace-pre-wrap"
                ><TaskRefText :text="JSON.stringify(step.input, null, 2)" /></pre>
              </div>
            </div>
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
        {{ entries.length === 0 && props.working ? props.working : `${props.agentName} is working…` }}
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
