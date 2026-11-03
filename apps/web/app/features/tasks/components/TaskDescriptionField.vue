<script setup lang="ts">
import { ref, toRaw } from 'vue'
import type { PatchTaskInput, Task } from '@corral/contracts'
import { wantsEdit } from '~/features/tasks/utils/taskDetail'

// The description, read until it's clicked. `sentTo` names who a change reaches.
const props = defineProps<{ task: Task, slug: string, readonly: boolean, sentTo: string | null, save: (input: PatchTaskInput) => Promise<boolean> }>()

const editingDescription = ref(false)
// The editor's JSON document; its inner shape is the editor's business
const descriptionDraft = ref<{ type: 'doc', content?: never[] }>({ type: 'doc', content: [] })
const uploadingImages = ref(0)

function startEditDescription() {
  descriptionDraft.value = structuredClone(toRaw(props.task.description ?? { type: 'doc', content: [] })) as { type: 'doc' }
  editingDescription.value = true
}
function onClick(event: MouseEvent) {
  if (wantsEdit(event)) startEditDescription()
}
async function saveDescription() {
  // Enter at the end leaves empty paragraphs behind
  const content = [...(descriptionDraft.value.content ?? [])] as { type: string, content?: unknown[] }[]
  while (content.length > 0 && content.at(-1)!.type === 'paragraph' && !content.at(-1)!.content?.length) content.pop()
  if (await props.save({ description: { ...descriptionDraft.value, content } as { type: 'doc' } })) editingDescription.value = false
}
</script>

<template>
  <section>
    <h3 class="mb-1 text-xs font-medium text-muted-foreground">
      Description
    </h3>
    <template v-if="editingDescription">
      <AsyncTaskDescription
        v-model:uploading="uploadingImages"
        :doc="descriptionDraft"
        :slug="slug"
        @update:doc="descriptionDraft = $event"
        @cancel="editingDescription = false"
      />
      <div class="mt-2 flex justify-end gap-2">
        <AppButton
          label="Cancel"
          variant="outline"
          color="neutral"
          size="sm"
          @click="editingDescription = false"
        />
        <AppButton
          :label="uploadingImages > 0 ? 'Uploading…' : 'Save'"
          size="sm"
          :disabled="uploadingImages > 0"
          @click="saveDescription"
        />
      </div>
    </template>
    <!-- Click anywhere on the description to edit it; links still open -->
    <div
      v-else
      :role="readonly ? undefined : 'button'"
      :tabindex="readonly ? undefined : 0"
      :aria-label="readonly ? undefined : 'Edit description'"
      :class="['-mx-2 rounded-md px-2 py-1', !readonly && 'cursor-text hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none']"
      @click="!readonly && onClick($event)"
      @keydown.enter.self.prevent="!readonly && startEditDescription()"
      @keydown.space.self.prevent="!readonly && startEditDescription()"
    >
      <RichTextText
        :doc="task.description"
        class="text-sm"
      />
    </div>
    <p
      v-if="sentTo"
      class="mt-1 text-xs text-muted-foreground"
    >
      Changes and comments are sent to {{ sentTo }}.
    </p>
  </section>
</template>
