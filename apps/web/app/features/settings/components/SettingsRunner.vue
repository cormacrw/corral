<script setup lang="ts">
import { cliLoginCommand } from '~/utils/labels'

const { isMobile } = useDevice()
</script>

<template>
  <div>
    <template v-if="isMobile">
      <MobilePageHeader />
      <SettingsRunnerMobile />
    </template>
    <AppCard v-else>
      <template #header>
        <h2 class="font-medium">
          Runners
        </h2>
      </template>
      <div class="flex flex-col gap-4 text-sm">
        <RunnerList />
        <p class="text-xs text-muted-foreground">
          Each runner keeps clones, worktrees and its spool in its own data directory, set by its configuration (a Docker volume when deployed).
        </p>
        <div>
          <RunnerLogins
            title="Logins"
            list-class="flex flex-col gap-1"
            skeleton-class="h-5 w-48"
          >
            <template #default="{ cli }">
              <li
                class="flex flex-wrap items-center gap-2"
                :data-testid="`cli-${cli.id}`"
              >
                <AppBadge
                  :label="cli.signedIn ? 'Signed in' : 'Not signed in'"
                  :color="cli.signedIn ? 'success' : 'warning'"
                  variant="subtle"
                  size="xs"
                />
                <span>{{ cli.name }} {{ cli.version ?? '(not found)' }}</span>
                <code
                  v-if="cli.version && !cli.signedIn"
                  class="font-mono text-xs text-muted-foreground"
                >{{ cliLoginCommand(cli.id) }}</code>
              </li>
            </template>
          </RunnerLogins>
          <p class="mt-2 text-xs text-muted-foreground">
            Sign in inside the runner container: <code class="font-mono">{{ cliLoginCommand('claude') }}</code>, <code class="font-mono">{{ cliLoginCommand('codex') }}</code> and <code class="font-mono">docker exec -it corral-runner gh auth login</code>. Corral shows the state only and never reads the credentials.
          </p>
        </div>
      </div>
    </AppCard>
  </div>
</template>
