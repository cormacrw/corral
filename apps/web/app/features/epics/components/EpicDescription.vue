<script setup lang="ts">
// The epic's description, edited in place. `save` resolves false when not saved,
// so the edit stays open.
const props = defineProps<{ description: string | null, save: (description: string) => Promise<boolean> }>()
const editing = ref(false)
const draft = ref('')

function startEdit(event?: MouseEvent) {
  // Following a link or selecting text shouldn't open the editor
  if (event && ((event.target as HTMLElement).closest('a') || window.getSelection()?.toString())) return
  draft.value = props.description ?? ''
  editing.value = true
}
async function submit() {
  if (await props.save(draft.value.trim())) editing.value = false
}
</script>

<template>
  <section>
    <h3 class="mb-1 text-xs font-medium text-muted-foreground">
      Description
    </h3>
    <template v-if="editing">
      <AppTextarea
        v-model="draft"
        autoresize
        autofocus
        :rows="5"
        placeholder="What this task is for, in markdown"
        class="w-full"
        @keydown.esc="editing = false"
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
          label="Save"
          size="sm"
          @click="submit"
        />
      </div>
    </template>
    <div
      v-else
      role="button"
      tabindex="0"
      aria-label="Edit description"
      class="-mx-2 cursor-text rounded-md px-2 py-1 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
      @click="startEdit($event)"
      @keydown.enter.self.prevent="startEdit()"
      @keydown.space.self.prevent="startEdit()"
    >
      <MarkdownText
        v-if="description"
        :text="description"
      />
      <span
        v-else
        class="text-muted-foreground/70"
      >Add a description…</span>
    </div>
  </section>
</template>
