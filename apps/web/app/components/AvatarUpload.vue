<script setup lang="ts">
import { squareImage } from '~/utils/image'

// Pick, resize and upload a profile picture, or remove it. The parent does
// the saving (the human's or an agent's endpoint) and the live state updates
// every avatar once the server confirms.
const props = withDefaults(defineProps<{
  name: string
  avatarUrl: string | null
  save: (image: Blob) => Promise<unknown>
  remove: () => Promise<unknown>
  size?: 'lg' | 'xl' | '3xl'
}>(), { size: 'xl' })

const toast = useToast()
const input = ref<HTMLInputElement | null>(null)
const busy = ref(false)

async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  busy.value = true
  try {
    await props.save(await squareImage(file))
  } catch (e) {
    toast.add({ title: 'Picture not saved', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    busy.value = false
  }
}
async function clear() {
  busy.value = true
  try {
    await props.remove()
  } catch (e) {
    toast.add({ title: 'Picture not removed', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex items-center gap-3">
    <AgentAvatar
      :name="props.name"
      :src="props.avatarUrl"
      :size="props.size"
    />
    <div class="flex flex-wrap gap-2">
      <input
        ref="input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        class="hidden"
        :aria-label="`Choose a picture for ${props.name}`"
        @change="upload"
      >
      <UButton
        :label="props.avatarUrl ? 'Change picture' : 'Upload picture'"
        icon="i-lucide-image-up"
        size="xs"
        variant="outline"
        color="neutral"
        :loading="busy"
        @click="input?.click()"
      />
      <UButton
        v-if="props.avatarUrl"
        label="Remove"
        size="xs"
        variant="ghost"
        color="neutral"
        :disabled="busy"
        @click="clear"
      />
    </div>
  </div>
</template>
