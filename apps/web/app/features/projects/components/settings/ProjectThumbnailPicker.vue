<script setup lang="ts">
import type { Project } from '@corral/contracts'
import type { ProjectSettings } from '~/features/projects/composables/useProjectSettings'
import { THUMBNAIL_COLORS } from '~/utils/labels'

// A colour saves with the form; an image applies at once
const props = defineProps<{ project: Project, settings: ProjectSettings }>()
const { form } = props.settings
const { busy, accept, upload, remove } = useProjectThumbnailUpload(() => props.project)
const input = ref<HTMLInputElement | null>(null)

function chosen(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (file) upload(file)
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <span
      class="relative inline-flex"
      :aria-busy="busy"
    >
      <ProjectThumbnail
        :project="{ ...project, name: form.name || project.name, thumbnailColor: form.thumbnailColor }"
        :size="40"
      />
      <span
        v-if="busy"
        role="status"
        aria-label="Updating thumbnail"
        class="absolute inset-0 flex items-center justify-center rounded-lg bg-background/80"
      >
        <Icon
          name="i-ri-loader-4-line"
          class="size-5 animate-spin"
        />
      </span>
    </span>
    <div
      role="radiogroup"
      aria-label="Thumbnail colour"
      class="flex gap-1.5"
    >
      <button
        v-for="color in THUMBNAIL_COLORS"
        :key="color"
        type="button"
        role="radio"
        :aria-checked="form.thumbnailColor === color"
        :aria-label="color"
        :class="['size-6 rounded-full', form.thumbnailColor === color && 'ring-2 ring-primary ring-offset-2 ring-offset-background']"
        :style="{ background: color }"
        @click="form.thumbnailColor = color"
      />
    </div>
    <input
      ref="input"
      type="file"
      :accept="accept"
      aria-label="Choose a project thumbnail"
      class="hidden"
      @change="chosen"
    >
    <AppButton
      label="Upload image"
      size="xs"
      variant="outline"
      color="neutral"
      :disabled="busy"
      @click="input?.click()"
    />
    <AppButton
      v-if="project.thumbnailUrl"
      label="Remove image"
      size="xs"
      variant="ghost"
      color="neutral"
      :disabled="busy"
      @click="remove"
    />
  </div>
</template>
