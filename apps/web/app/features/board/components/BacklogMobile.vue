<script setup lang="ts">
import type { Backlog } from '~/features/board/composables/useBacklog'
import { moveGroupLabel, movableRows, priorityText } from '~/features/board/utils/backlog'
import { PRIORITY } from '~/utils/labels'

// The Backlog on a phone (design/backlog.md, design/mobile.md): the same epic
// groups as the web page, stacked, with rows that open the task's page.
// useBacklog owns the data and the moves, so both layouts behave the same.
const props = defineProps<{ backlog: Backlog }>()
const { search, showCompleted, collapsed, groups, summary, planTo, pmName, inPlan, toggle, moving, moveToBoard, moveEpic, creating, newTask, loading, error, refetch } = props.backlog
</script>

<template>
  <div class="*:shrink-0 flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
    <MobilePageHeader>
      <template #actions>
        <AppButton
          icon="i-ri-add-line"
          variant="ghost"
          color="neutral"
          aria-label="New task"
          :loading="creating"
          @click="newTask"
        />
      </template>
    </MobilePageHeader>

    <div class="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
      <AppInput
        v-model="search"
        placeholder="Search Backlog"
        icon="i-ri-search-line"
        size="lg"
        variant="soft"
      />
      <p class="text-xs text-muted-foreground">
        {{ summary }}
      </p>
      <AppCheckbox
        v-model="showCompleted"
        label="Show completed"
      />
    </div>

    <AppLoadError
      v-if="error"
      :title="error"
      :retry="refetch"
      class="m-4"
    />
    <div
      v-else-if="loading"
      class="flex flex-col gap-3 p-4"
    >
      <UiSkeleton class="h-40 w-full" />
      <UiSkeleton class="h-40 w-full" />
    </div>
    <div
      v-else
      class="flex flex-col gap-3 p-4"
    >
      <section
        v-for="group in groups"
        :key="group.id"
        :aria-label="`${group.title}, ${group.rows.length}`"
        class="overflow-hidden rounded-lg border border-border"
      >
        <header class="flex flex-col gap-2 bg-muted/50 px-3 py-2.5 text-sm">
          <div class="flex items-center gap-2">
            <BacklogGroupHeading
              :group="group"
              :collapsed="Boolean(collapsed[group.id])"
              mobile
              @toggle="toggle(group.id)"
            />
          </div>
          <div
            v-if="!collapsed[group.id]"
            class="grid grid-cols-2 gap-2"
          >
            <AppButton
              :to="planTo"
              :label="`Plan with ${pmName}`"
              icon="i-ri-message-2-line"
              variant="outline"
              color="neutral"
              block
            />
            <AppButton
              v-if="movableRows(group).length > 0"
              :label="moveGroupLabel(group)"
              icon="i-ri-kanban-view"
              variant="outline"
              color="neutral"
              block
              :loading="group.rows.some(t => moving.has(t.id))"
              @click="moveEpic(group)"
            />
          </div>
        </header>
        <ul v-if="!collapsed[group.id]">
          <li
            v-for="task in group.rows"
            :key="task.id"
            class="flex items-center border-t border-border pe-2"
          >
            <NuxtLink
              :to="`/tasks/${task.ref}`"
              class="flex min-w-0 flex-1 flex-col gap-1 px-3 py-3 text-sm active:bg-muted"
            >
              <span class="flex items-baseline gap-3">
                <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ task.ref }}</span>
                <span class="min-w-0 flex-1 text-foreground">{{ task.title }}</span>
              </span>
              <span class="flex items-center gap-2 text-xs">
                <AppBadge
                  v-if="inPlan(task)"
                  label="In plan"
                  size="xs"
                  variant="subtle"
                  color="primary"
                />
                <span :class="priorityText(task)">{{ PRIORITY[task.priority].label }}</span>
                <TaskTypeBadge :type="task.type" />
                <StatusBadge :status="task.status" />
                <DesignChangedBadge :design="task.design" />
              </span>
            </NuxtLink>
            <AppButton
              v-if="task.status === 'backlog'"
              icon="i-ri-kanban-view"
              variant="ghost"
              color="neutral"
              :loading="moving.has(task.id)"
              :aria-label="`Move ${task.ref} to board`"
              class="tap-target shrink-0"
              @click="moveToBoard([task])"
            />
          </li>
        </ul>
      </section>
      <p
        v-if="groups.length === 0"
        class="text-sm text-muted-foreground"
      >
        Nothing in the Backlog. Plan something with {{ pmName }} or add a task.
      </p>
    </div>
  </div>
</template>
