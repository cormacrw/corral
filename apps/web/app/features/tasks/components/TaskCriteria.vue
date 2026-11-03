<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Epic, PatchTaskInput, Task } from '@corral/contracts'
import CriterionMetIcon from '~/features/evidence/components/CriterionMetIcon.vue'
import { wantsEdit } from '~/features/tasks/utils/taskDetail'

const props = defineProps<{ task: Task, epic: Epic | null, readonly: boolean, save: (input: PatchTaskInput) => Promise<boolean> }>()

const newCriterion = ref('')
const editingCriterion = ref<string | null>(null)
const metCount = computed(() => props.task.acceptanceCriteria.filter(c => c.met).length)
const note = computed(() => {
  if (!props.task.acceptanceCriteria.some(c => c.checkedByHuman)) return 'The reviewer marks criteria met from evidence.'
  return props.epic?.reviewMode === 'epic' && !props.task.pr && ['task', 'bug'].includes(props.task.type)
    ? 'The reviewer checks other criteria from evidence. Human checks are completed on the parent review, once the parent is ready.'
    : 'The reviewer checks other criteria from evidence. Human checks are completed in the Inbox.'
})

// The list as the server takes it, without what the reviewer set
const criteria = () => props.task.acceptanceCriteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman }))
const toggleHuman = (id: string, checked: boolean) => props.save({ acceptanceCriteria: criteria().map(c => c.id === id ? { ...c, checkedByHuman: checked } : c) })
const saveCriterion = (id: string, text: string) => props.save({ acceptanceCriteria: criteria().map(c => c.id === id ? { ...c, text } : c).filter(c => c.text.trim()) })
const removeCriterion = (id: string) => props.save({ acceptanceCriteria: criteria().filter(c => c.id !== id) })
async function addCriterion() {
  const text = newCriterion.value.trim()
  if (text && await props.save({ acceptanceCriteria: [...criteria(), { text }] })) newCriterion.value = ''
}
</script>

<template>
  <section>
    <div class="mb-1 flex items-center justify-between">
      <h3 class="text-xs font-medium text-muted-foreground">
        Acceptance criteria · {{ metCount }} of {{ task.acceptanceCriteria.length }} met
      </h3>
    </div>
    <ul class="flex flex-col gap-1">
      <li
        v-for="criterion in task.acceptanceCriteria"
        :key="criterion.id"
        class="flex items-start gap-2 text-sm"
      >
        <CriterionMetIcon
          :met="criterion.met"
          class="mt-1"
        />
        <div class="min-w-0 flex-1">
          <div
            v-if="readonly || editingCriterion !== criterion.id"
            :role="readonly ? undefined : 'button'"
            :tabindex="readonly ? undefined : 0"
            :aria-label="readonly ? undefined : `Edit criterion: ${criterion.text}`"
            class="rounded px-1 py-0.5 hover:bg-muted"
            @click="!readonly && wantsEdit($event) && (editingCriterion = criterion.id)"
            @keydown.enter.self.prevent="!readonly && (editingCriterion = criterion.id)"
          >
            <MarkdownText :text="criterion.text" />
          </div>
          <AppTextarea
            v-else
            :model-value="criterion.text"
            autofocus
            autoresize
            :rows="1"
            variant="none"
            class="min-h-0 w-full px-1 py-0 text-sm/6 hover:bg-muted focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-primary md:text-sm/6"
            :aria-label="`Criterion: ${criterion.text}`"
            @change="saveCriterion(criterion.id, ($event.target as HTMLTextAreaElement).value)"
            @blur="editingCriterion = null"
          />
          <label class="mt-1 flex items-center gap-1 px-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              :checked="criterion.checkedByHuman"
              :disabled="readonly"
              @change="toggleHuman(criterion.id, ($event.target as HTMLInputElement).checked)"
            >
            Checked by a human
          </label>
        </div>
        <AppButton
          v-if="!readonly"
          icon="i-ri-close-line"
          size="xs"
          variant="ghost"
          color="neutral"
          class="tap-target"
          aria-label="Remove criterion"
          @click="removeCriterion(criterion.id)"
        />
      </li>
    </ul>
    <form
      v-if="!readonly"
      class="mt-2 flex gap-2"
      @submit.prevent="addCriterion"
    >
      <AppInput
        v-model="newCriterion"
        placeholder="Add criterion"
        size="sm"
        class="flex-1"
      />
      <AppButton
        type="submit"
        label="Add"
        size="sm"
        variant="outline"
        color="neutral"
        :disabled="!newCriterion.trim()"
      />
    </form>
    <p class="mt-1 text-xs text-muted-foreground">
      {{ note }}
    </p>
  </section>
</template>
