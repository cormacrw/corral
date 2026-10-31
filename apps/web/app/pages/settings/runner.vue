<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { clisQuery } from '~/queries/setup'
import { cliLoginCommand } from '~/utils/labels'

const device = useDevice()
const cliScan = useQuery(clisQuery())
const clis = computed(() => cliScan.data.value ?? null)
const cliError = computed(() => cliScan.error.value?.message ?? null)
const scan = () => cliScan.refetch()
</script>

<template>
  <div>
    <template v-if="device.isMobile.value">
      <MobilePageHeader />
      <SettingsRunnerMobile
        :clis="clis"
        :cli-error="cliError"
        @scan="scan"
      />
    </template>
    <UCard v-else>
      <template #header>
        <h2 class="font-medium">
          Runners
        </h2>
      </template>
      <div class="flex flex-col gap-4 text-sm">
        <RunnerList />
        <p class="text-xs text-muted">
          Each runner keeps clones, worktrees and its spool in its own data directory, set by its configuration (a Docker volume when deployed).
        </p>
        <div>
          <div class="mb-1 flex items-center gap-2">
            <span class="font-medium">Logins</span>
            <UButton
              label="Scan again"
              size="xs"
              variant="ghost"
              color="neutral"
              @click="scan"
            />
          </div>
          <UAlert
            v-if="cliError"
            color="warning"
            variant="subtle"
            :title="cliError"
          />
          <ul
            v-else-if="clis"
            class="flex flex-col gap-1"
          >
            <li
              v-for="cli in clis"
              :key="cli.id"
              class="flex flex-wrap items-center gap-2"
              :data-testid="`cli-${cli.id}`"
            >
              <UBadge
                :label="cli.signedIn ? 'Signed in' : 'Not signed in'"
                :color="cli.signedIn ? 'success' : 'warning'"
                variant="subtle"
                size="xs"
              />
              <span>{{ cli.name }} {{ cli.version ?? '(not found)' }}</span>
              <code
                v-if="cli.version && !cli.signedIn"
                class="font-mono text-xs text-muted"
              >{{ cliLoginCommand(cli.id) }}</code>
            </li>
          </ul>
          <USkeleton
            v-else
            class="h-5 w-48"
          />
          <p class="mt-2 text-xs text-muted">
            Sign in inside the runner container: <code class="font-mono">{{ cliLoginCommand('claude') }}</code>, <code class="font-mono">{{ cliLoginCommand('codex') }}</code> and <code class="font-mono">docker exec -it corral-runner gh auth login</code>. Corral shows the state only and never reads the credentials.
          </p>
        </div>
      </div>
    </UCard>
  </div>
</template>
