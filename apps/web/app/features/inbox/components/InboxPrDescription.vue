<script setup lang="ts">
import type { PullRequestDetail } from '@corral/contracts'

// A PR's title, branches and body. `icon` marks it as a PR where nothing around it does.
defineProps<{ pr: PullRequestDetail, icon?: boolean }>()
</script>

<template>
  <div
    class="flex flex-col gap-3"
    data-testid="inbox-pr-description"
  >
    <div class="text-sm text-muted-foreground">
      <p class="flex items-center gap-2 font-medium text-foreground">
        <Icon
          v-if="icon"
          name="i-hugeicons-git-pull-request"
          class="size-4 shrink-0 text-muted-foreground"
        />
        <span class="min-w-0">#{{ pr.number }} {{ pr.title }}</span>
      </p>
      <p class="truncate">
        {{ pr.headBranch }} → {{ pr.baseBranch }}
      </p>
    </div>
    <MarkdownText
      v-if="pr.body"
      :text="pr.body"
      class="text-sm"
    />
    <p
      v-else
      class="text-sm text-muted-foreground"
    >
      This PR has no description.
    </p>
  </div>
</template>
