<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { PRIORITY, ROLE, STATUS, taskNote } from '~/utils/labels'

const props = defineProps<{ task: Task, option: string, all: Task[], selected: boolean }>()
defineEmits<{ open: [] }>()
const live = useLive()
const agent = computed(() => props.task.lease ? live.state.value.agents.find(a => a.id === props.task.lease!.agentId) : null)
const epic = computed(() => live.state.value.epics[props.task.projectId]?.find(e => e.id === props.task.epicId)?.title)
const note = computed(() => taskNote(props.task, props.all, 3))
const tone = computed(() => note.value?.color === 'error' ? 'text-error' : note.value?.color === 'warning' ? 'text-warning' : 'text-muted')
const activity = computed(() => agent.value ? `${agent.value.name} is working` : note.value?.text ?? STATUS[props.task.status].label)
const met = computed(() => props.task.acceptanceCriteria.filter(c => c.met === true).length)
</script>

<template>
  <BorderGlow
    :active="Boolean(task.lease)"
    :glow-radius="8"
    class="min-w-0 shrink-0"
  >
    <article
      :data-card="task.ref"
      :data-option="option"
      :class="[
        'relative min-w-0 rounded-md border bg-default text-sm transition-colors hover:border-accented',
        selected ? 'border-primary ring-1 ring-primary' : 'border-default',
        task.lease && 'border-primary/60',
        option === 'b' ? 'p-2' : 'p-3',
        option === 'c' && 'border-s-4',
        option === 'c' && (note?.color === 'error' ? 'border-s-error' : note?.color === 'warning' ? 'border-s-warning' : 'border-s-primary')
      ]"
    >
      <button
        type="button"
        :aria-label="`Open ${task.ref}: ${task.title}`"
        :aria-pressed="selected"
        class="absolute inset-0 z-[2] rounded-md focus-visible:outline-2 focus-visible:outline-primary"
        @click="$emit('open')"
      />
      <div
        v-if="option === 'c'"
        :class="['mb-2 border-b border-default pb-2 text-xs font-medium', agent ? 'text-primary' : tone]"
      >
        {{ activity }}
      </div>
      <div
        v-if="option === 'd'"
        class="mb-3 flex items-center gap-2"
      >
        <AgentAvatar
          v-if="agent"
          :name="agent.name"
          working
          size="sm"
        />
        <UIcon
          v-else
          name="i-lucide-circle-dashed"
          class="size-8 text-dimmed"
        />
        <div class="min-w-0 text-xs">
          <p class="font-semibold text-highlighted">
            {{ agent?.name ?? 'Not claimed' }}
          </p>
          <p class="text-muted">
            {{ agent ? `${ROLE[agent.role]} · Working` : 'Available to the team' }}
          </p>
        </div>
      </div>
      <div :class="['flex flex-wrap items-center gap-x-2 gap-y-1 text-xs', option === 'e' ? 'mb-2' : 'mb-1.5']">
        <span class="font-mono text-muted">{{ task.ref }}</span>
        <span
          v-if="option !== 'd'"
          :class="task.priority === 'urgent' ? 'text-error' : task.priority === 'high' ? 'text-warning' : 'text-muted'"
        >{{ PRIORITY[task.priority].label }}</span>
        <TaskTypeBadge :type="task.type" />
        <a
          v-if="task.prUrl"
          :href="task.prUrl"
          target="_blank"
          rel="noopener"
          :aria-label="`Open PR #${task.prNumber}`"
          class="relative z-[3] ms-auto flex items-center gap-0.5 text-muted hover:text-primary"
          @click.stop
        >
          <UIcon
            name="i-lucide-git-pull-request"
            class="size-3"
          />#{{ task.prNumber }}
        </a>
      </div>
      <p :class="['break-words font-medium text-highlighted', option === 'e' && 'text-base', option === 'b' && 'text-xs leading-5']">
        {{ task.title }}
      </p>
      <div
        v-if="task.design?.newerVersion"
        class="mt-2 flex flex-wrap"
      >
        <DesignChangedBadge :design="task.design" />
      </div>
      <p
        v-if="note && option !== 'c'"
        :class="['mt-1.5 text-xs', tone]"
      >
        {{ note.text }}
      </p>
      <div
        v-if="option === 'e'"
        class="mt-3 rounded-md bg-muted p-2 text-xs text-muted"
      >
        <div class="flex justify-between gap-2">
          <span>Criteria met</span><span class="font-mono text-default">{{ met }}/{{ task.acceptanceCriteria.length }}</span>
        </div>
        <div
          class="mt-1.5 flex gap-1"
          aria-hidden="true"
        >
          <span
            v-for="c in task.acceptanceCriteria"
            :key="c.id"
            :class="['h-1 flex-1 rounded-full', c.met === true ? 'bg-success' : 'bg-accented']"
          />
        </div>
        <p class="mt-1.5">
          {{ task.reviewRounds ? `Review round ${task.reviewRounds} of 3` : 'No review yet' }}
        </p>
        <p
          v-if="task.dependsOn.length"
          class="mt-1"
        >
          Depends on {{ task.dependsOn.join(', ') }}
        </p>
      </div>
      <div
        v-if="epic || agent || option === 'd'"
        :class="['mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted', option === 'e' && 'border-t border-default pt-2']"
      >
        <span
          v-if="epic"
          class="min-w-0 break-words"
        >{{ epic }}</span>
        <span
          v-if="option === 'd'"
          :class="['ms-auto', task.priority === 'urgent' ? 'text-error' : task.priority === 'high' ? 'text-warning' : 'text-muted']"
        >{{ PRIORITY[task.priority].label }}</span>
        <span
          v-else-if="agent"
          class="ms-auto flex items-center gap-1"
        ><AgentAvatar
          :name="agent.name"
          working
          size="xs"
        />{{ agent.name }}<span v-if="option === 'a' || option === 'e'">· Working</span></span>
      </div>
    </article>
  </BorderGlow>
</template>
