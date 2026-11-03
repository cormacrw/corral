<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'

const props = defineProps<{ setup: Setup }>()
const { repos, repoSearch, repoRows, picked, pick, pasted, showPaste, pickPasted, loadRepos } = props.setup
const { isMobile } = useDevice()
</script>

<template>
  <div class="flex items-start justify-between gap-2">
    <div>
      <p class="text-sm font-medium">
        Repository <span class="text-destructive">*</span>
      </p>
      <!-- The web page says this in its subheading -->
      <p
        v-if="isMobile"
        class="text-xs text-muted-foreground"
      >
        Repositories the runner's GitHub login can see
      </p>
    </div>
    <AppButton
      label="Refresh"
      :size="isMobile ? 'md' : 'xs'"
      variant="ghost"
      color="neutral"
      icon="i-ri-refresh-line"
      @click="loadRepos()"
    />
  </div>
  <div class="overflow-hidden rounded-md border border-border">
    <AppInput
      v-model="repoSearch"
      :placeholder="`Search ${repos?.signedIn ? repos.repos.length : ''} repositories`"
      icon="i-ri-search-line"
      variant="none"
      :size="isMobile ? 'lg' : 'md'"
      :class="['w-full border-b border-border', isMobile && 'bg-muted/50']"
    />
    <ul
      role="listbox"
      aria-label="Repositories"
      class="max-h-72 overflow-y-auto overscroll-contain"
    >
      <li
        v-for="repo in repoRows"
        :key="repo.nameWithOwner"
      >
        <SetupRepoRow
          :repo="repo"
          :selected="picked?.nameWithOwner === repo.nameWithOwner"
          @pick="pick(repo)"
        />
      </li>
      <li
        v-if="repos && repoRows.length === 0"
        class="p-4 text-sm text-muted-foreground"
      >
        No repositories match.
      </li>
      <li
        v-if="!repos"
        class="p-4"
      >
        <UiSkeleton class="h-5 w-full" />
      </li>
    </ul>
  </div>
  <div>
    <AppButton
      label="Can't find it? Paste a GitHub URL"
      variant="link"
      color="neutral"
      :size="isMobile ? 'md' : 'xs'"
      class="px-0 font-medium"
      @click="showPaste = !showPaste"
    />
    <form
      v-if="showPaste"
      :class="['mt-2 flex gap-2', isMobile && 'flex-col']"
      @submit.prevent="pickPasted"
    >
      <AppInput
        v-model="pasted"
        placeholder="https://github.com/owner/name"
        :size="isMobile ? 'lg' : 'md'"
        class="flex-1"
      />
      <AppButton
        type="submit"
        label="Check access"
        variant="outline"
        color="neutral"
        :size="isMobile ? 'lg' : 'md'"
        :block="isMobile"
      />
    </form>
  </div>
</template>
