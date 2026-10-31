<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query'
import { patchProfile, profileQuery, setProfileAvatar } from '~/queries/system'

const { data: profile } = useQuery(profileQuery())
const profilePatch = useMutation(patchProfile)
const profileAvatar = useMutation(setProfileAvatar)
const toast = useToast()
// Kept on the server with the picture, so every browser shows the same name
const userName = ref(profile.value?.name ?? '')
watch(() => profile.value?.name, (name) => {
  if (name !== undefined) userName.value = name
})
async function saveName() {
  const name = userName.value.trim()
  if (name === profile.value?.name) return
  try {
    await profilePatch.mutateAsync({ name })
    toast.add({ title: 'Saved', color: 'success' })
  } catch (e) {
    toast.add({ title: 'Not saved', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
async function saveMyAvatar(image: Blob | null) {
  await profileAvatar.mutateAsync(image)
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-medium">
        Profile
      </h2>
    </template>
    <div class="mb-5 grid gap-2 sm:grid-cols-[1fr_320px]">
      <div>
        <span class="font-medium">Picture</span>
        <p class="text-xs text-muted">
          Shown on your comments, approvals and in the sidebar. Cropped to a square.
        </p>
      </div>
      <AvatarUpload
        name="You"
        :avatar-url="profile?.avatarUrl ?? null"
        :save="(image: Blob) => saveMyAvatar(image)"
        :remove="() => saveMyAvatar(null)"
      />
    </div>
    <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
      <div>
        <label
          for="yourName"
          class="font-medium"
        >Your name</label>
        <p class="text-xs text-muted">
          How agents address you.
        </p>
      </div>
      <UInput
        id="yourName"
        v-model="userName"
        :maxlength="80"
        @change="saveName"
      />
    </div>
  </UCard>
</template>
