<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
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
    toast.add({ title: 'Not saved', description: errorMessage(e), color: 'error' })
  }
}
async function saveAvatar(image: Blob | null) {
  await profileAvatar.mutateAsync(image)
}
</script>

<template>
  <AppCard>
    <template #header>
      <h2 class="font-medium">
        Profile
      </h2>
    </template>
    <div class="flex flex-col gap-5">
      <SettingsField
        title="Picture"
        description="Shown on your comments, approvals and in the sidebar. Cropped to a square."
      >
        <AvatarUpload
          name="You"
          :avatar-url="profile?.avatarUrl ?? null"
          :save="(image: Blob) => saveAvatar(image)"
          :remove="() => saveAvatar(null)"
        />
      </SettingsField>
      <SettingsField
        title="Your name"
        description="How agents address you."
        for="yourName"
      >
        <AppInput
          id="yourName"
          v-model="userName"
          :maxlength="80"
          @change="saveName"
        />
      </SettingsField>
    </div>
  </AppCard>
</template>
