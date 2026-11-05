<script setup lang="ts">
import { computed, ref, toRaw } from 'vue'
import type { PatchTaskInput, Task } from '@corral/contracts'
import { wantsEdit } from '~/features/tasks/utils/taskDetail'

// The implementation plan agents build from, below the description. Collapsed
// until opened, and absent when the task has none: an editor sees only a way
// to add one.
const props = defineProps<{ task: Task, slug: string, readonly: boolean, save: (input: PatchTaskInput) => Promise<boolean> }>()

type Doc = { type: 'doc', content?: { type: string, content?: unknown[] }[] }
const open = ref(false)
const editing = ref(false)
const draft = ref<Doc>({ type: 'doc', content: [] })
const uploadingImages = ref(0)

const plan = computed(() => props.task.implementationPlan as Doc | null)
const hasPlan = computed(() => Boolean(plan.value?.content?.some(node => node.type !== 'paragraph' || node.content?.length)))

function startEdit() {
  draft.value = structuredClone(toRaw(plan.value ?? { type: 'doc', content: [] }))
  open.value = true
  editing.value = true
}
function onClick(event: MouseEvent) {
  if (wantsEdit(event)) startEdit()
}
async function savePlan() {
  // Enter at the end leaves empty paragraphs behind
  const content = [...(draft.value.content ?? [])]
  while (content.length > 0 && content.at(-1)!.type === 'paragraph' && !content.at(-1)!.content?.length) content.pop()
  if (await props.save({ implementationPlan: content.length ? { ...draft.value, content } as { type: 'doc' } : null })) editing.value = false
}
</script>

<template>
  <section
    v-if="hasPlan || editing"
    aria-label="Implementation plan"
  >
    <AppButton
      label="Implementation plan"
      :icon="open ? 'i-hugeicons-arrow-down-01' : 'i-hugeicons-arrow-right-01'"
      variant="link"
      color="neutral"
      size="xs"
      class="mb-1 px-0 text-xs font-medium text-muted-foreground"
      :aria-expanded="open"
      @click="open = !open"
    />
    <template v-if="open && editing">
      <AsyncTaskDescription
        v-model:uploading="uploadingImages"
        :doc="draft"
        :slug="slug"
        @update:doc="draft = $event"
        @cancel="editing = false"
      />
      <div class="mt-2 flex justify-end gap-2">
        <AppButton
          label="Cancel"
          variant="outline"
          color="neutral"
          size="sm"
          @click="editing = false"
        />
        <AppButton
          :label="uploadingImages > 0 ? 'Uploading…' : 'Save'"
          size="sm"
          :disabled="uploadingImages > 0"
          @click="savePlan"
        />
      </div>
    </template>
    <!-- Click anywhere on the plan to edit it; links still open -->
    <div
      v-else-if="open"
      :role="readonly ? undefined : 'button'"
      :tabindex="readonly ? undefined : 0"
      :aria-label="readonly ? undefined : 'Edit implementation plan'"
      :class="['-mx-2 rounded-md px-2 py-1', !readonly && 'cursor-text hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none']"
      @click="!readonly && onClick($event)"
      @keydown.enter.self.prevent="!readonly && startEdit()"
      @keydown.space.self.prevent="!readonly && startEdit()"
    >
      <RichTextText
        :doc="plan"
        class="text-sm"
      />
    </div>
  </section>
  <AppButton
    v-else-if="!readonly"
    label="Add implementation plan"
    icon="i-hugeicons-add-01"
    variant="link"
    color="neutral"
    size="xs"
    class="self-start px-0 text-muted-foreground"
    @click="startEdit"
  />
</template>
