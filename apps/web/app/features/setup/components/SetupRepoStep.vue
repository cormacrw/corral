<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'

const props = defineProps<{ setup: Setup }>()
const { repos, reposError, loadRepos, picked } = props.setup
const { isMobile } = useDevice()
</script>

<template>
  <div class="flex flex-col gap-4">
    <AppLoadError
      v-if="reposError"
      title="Could not load repositories"
      :description="reposError"
      :retry="loadRepos"
    />
    <AppAlert
      v-else-if="repos && !repos.signedIn"
      color="warning"
      variant="subtle"
      icon="i-ri-github-line"
      title="The runner isn't signed in to GitHub"
    >
      <template #description>
        <p class="mb-2">
          Sign in inside the runner, then check again. Corral never sees the token.
        </p>
        <pre class="overflow-x-auto overscroll-x-contain rounded bg-muted p-2 font-mono text-xs">docker exec -it corral-runner gh auth login</pre>
        <AppButton
          label="Check again"
          :size="isMobile ? 'sm' : 'xs'"
          class="mt-2"
          @click="loadRepos()"
        />
      </template>
    </AppAlert>
    <SetupRepoPicker
      v-else
      :setup="setup"
    />

    <template v-if="picked">
      <SetupRepoOptions :setup="setup" />
      <SetupRepoChecks :setup="setup" />
    </template>
  </div>
</template>
