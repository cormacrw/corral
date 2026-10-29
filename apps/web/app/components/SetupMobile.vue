<script setup lang="ts">
import type { Setup } from '~/composables/useSetup'
import { initials, timeAgo } from '~/utils/labels'

// Onboarding on mobile (design/mobile.md, frames "Setup · Your name",
// "Repository", "Agent CLIs" and "Name agents"). The same steps and rules as
// the web page in one column, with a progress bar in place of the stepper and
// the step's action pinned to the bottom. It sits in the bare layout: no tab bar.
const props = defineProps<{ setup: Setup }>()
const { adding, steps, step, index, userName, savingName, repos, reposError, repoSearch, picked, pasted, showPaste, check, checking, defaultBranch, mergeMethod, loadRepos, repoRows, pick, clis, cliError, scan, cliDetail, agentNames, suggest, finishing, next, canContinue } = props.setup

const TITLES: Record<string, string> = { you: 'Your name', repo: 'Choose a repository', agents: 'Confirm agent CLIs', names: 'Name your agents' }
const title = computed(() => adding.value ? 'Add a project' : TITLES[step.value] ?? 'Set up Corral')
const ROLES = [
  { role: 'pm', label: 'PM', description: 'Plans with you in Plan and proposes tasks' },
  { role: 'developer', label: 'Developer', description: 'Builds tasks in a worktree and opens PRs' },
  { role: 'reviewer', label: 'Reviewer', description: 'Checks each PR against its acceptance criteria' }
] as const

function back() {
  if (adding.value) return void navigateTo('/projects')
  if (index.value > 0) step.value = steps[index.value - 1]!.value
}
</script>

<template>
  <div class="flex h-svh flex-col">
    <header class="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-default px-4 pt-[env(safe-area-inset-top)]">
      <template v-if="index === 0 && !adding">
        <span class="flex items-center gap-2 text-lg font-semibold">
          <span class="flex size-7 items-center justify-center rounded-md bg-primary text-inverted"><UIcon
            name="i-lucide-fence"
            class="size-4"
          /></span>
          Corral
        </span>
        <UBadge
          label="Self-hosted"
          color="neutral"
          variant="subtle"
        />
      </template>
      <template v-else>
        <UButton
          icon="i-lucide-arrow-left"
          variant="ghost"
          color="neutral"
          aria-label="Back"
          @click="back"
        />
        <h1 class="min-w-0 flex-1 truncate text-lg font-semibold">
          {{ title }}
        </h1>
      </template>
    </header>

    <main class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-6">
      <div
        v-if="!adding"
        class="flex flex-col gap-2"
      >
        <div
          class="flex gap-1.5"
          role="progressbar"
          aria-label="Setup progress"
          :aria-valuenow="index + 1"
          aria-valuemin="1"
          :aria-valuemax="steps.length"
        >
          <span
            v-for="(s, i) in steps"
            :key="s.value"
            :class="['h-1 flex-1 rounded-full', i <= index ? 'bg-primary' : 'bg-elevated']"
          />
        </div>
        <p class="text-xs font-medium text-muted">
          Step {{ index + 1 }} of {{ steps.length }} · {{ steps[index]?.title }}
        </p>
      </div>

      <template v-if="step === 'you'">
        <div>
          <h1 class="text-2xl font-semibold">
            What should agents call you?
          </h1>
          <p class="mt-1 text-muted">
            Used on comments, approvals and PM questions.
          </p>
        </div>
        <UFormField
          label="Your name"
          required
        >
          <UInput
            v-model="userName"
            size="xl"
            icon="i-lucide-user"
            placeholder="Your name"
            :maxlength="80"
            class="w-full"
          />
        </UFormField>
        <div class="flex items-center gap-3 rounded-md border border-default bg-elevated/50 p-3 text-sm text-muted">
          <UAvatar
            :text="initials(userName || 'You')"
            size="lg"
          />
          How you'll appear on comments, approvals and PM questions
        </div>
        <p class="text-xs text-muted">
          Saved on this server, so every device sees it.
        </p>
      </template>

      <template v-else-if="step === 'repo'">
        <UAlert
          v-if="reposError"
          color="error"
          variant="subtle"
          :title="reposError"
          :actions="[{ label: 'Try again', onClick: () => loadRepos(true) }]"
        />
        <UAlert
          v-else-if="repos && !repos.signedIn"
          color="warning"
          variant="subtle"
          icon="i-lucide-github"
          title="The runner isn't signed in to GitHub"
        >
          <template #description>
            <p class="mb-2">
              Sign in inside the runner, then check again. Corral never sees the token.
            </p>
            <pre class="overflow-x-auto rounded bg-elevated p-2 font-mono text-xs">docker exec -it corral-runner gh auth login</pre>
            <UButton
              label="Check again"
              size="sm"
              class="mt-2"
              @click="loadRepos(true)"
            />
          </template>
        </UAlert>
        <template v-else>
          <div class="flex items-start justify-between gap-2">
            <div>
              <p class="font-medium">
                Repository <span class="text-error">*</span>
              </p>
              <p class="text-xs text-muted">
                Repositories the runner's GitHub login can see
              </p>
            </div>
            <UButton
              label="Refresh"
              variant="ghost"
              color="neutral"
              icon="i-lucide-refresh-cw"
              @click="loadRepos(true)"
            />
          </div>
          <div class="overflow-hidden rounded-md border border-default">
            <UInput
              v-model="repoSearch"
              :placeholder="`Search ${repos?.signedIn ? repos.repos.length : ''} repositories`"
              icon="i-lucide-search"
              variant="none"
              size="lg"
              class="w-full border-b border-default bg-elevated/50"
            />
            <ul
              role="listbox"
              aria-label="Repositories"
              class="max-h-72 overflow-y-auto"
            >
              <li
                v-for="repo in repoRows"
                :key="repo.nameWithOwner"
              >
                <button
                  type="button"
                  role="option"
                  :aria-selected="picked?.nameWithOwner === repo.nameWithOwner"
                  :disabled="!repo.selectable"
                  :class="['flex w-full items-start gap-2 border-b border-default px-3 py-3 text-start text-sm disabled:opacity-60', picked?.nameWithOwner === repo.nameWithOwner ? 'bg-primary/10 ring-1 ring-primary ring-inset' : 'active:bg-elevated']"
                  @click="pick(repo)"
                >
                  <UIcon
                    :name="repo.isPrivate ? 'i-lucide-lock' : 'i-lucide-book'"
                    class="mt-0.5 size-4 shrink-0 text-muted"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span class="truncate"><span class="text-muted">{{ repo.nameWithOwner.split('/')[0] }}/</span><span class="font-semibold">{{ repo.nameWithOwner.split('/')[1] }}</span></span>
                      <UBadge
                        :label="repo.isPrivate ? 'Private' : 'Public'"
                        size="sm"
                        variant="subtle"
                        color="neutral"
                      />
                    </span>
                    <span
                      v-if="repo.description"
                      class="block truncate text-xs text-muted"
                    >{{ repo.description }}</span>
                    <span
                      v-if="repo.reason"
                      class="block text-xs text-warning"
                    >{{ repo.reason === 'read_only' ? 'Read-only access: agents couldn’t push branches or open PRs' : `Used by ${repo.usedBy?.name}` }}</span>
                    <span class="block text-xs text-muted">
                      Updated {{ timeAgo(repo.updatedAt) }} · <span class="font-mono">{{ repo.defaultBranch }}</span>
                    </span>
                  </span>
                  <UIcon
                    v-if="picked?.nameWithOwner === repo.nameWithOwner"
                    name="i-lucide-check"
                    class="mt-0.5 size-4 shrink-0 text-primary"
                  />
                </button>
              </li>
              <li
                v-if="repos && repoRows.length === 0"
                class="p-4 text-sm text-muted"
              >
                No repositories match.
              </li>
              <li
                v-if="!repos"
                class="p-4"
              >
                <USkeleton class="h-5 w-full" />
              </li>
            </ul>
          </div>
          <div>
            <UButton
              label="Can't find it? Paste a GitHub URL"
              variant="link"
              color="neutral"
              class="px-0 font-medium"
              @click="showPaste = !showPaste"
            />
            <form
              v-if="showPaste"
              class="mt-2 flex flex-col gap-2"
              @submit.prevent="pick(pasted.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, ''))"
            >
              <UInput
                v-model="pasted"
                placeholder="https://github.com/owner/name"
                size="lg"
                class="w-full"
              />
              <UButton
                type="submit"
                label="Check access"
                variant="outline"
                color="neutral"
                size="lg"
                block
              />
            </form>
          </div>
        </template>

        <template v-if="picked">
          <UFormField
            label="Default branch"
            help="From GitHub. Agents branch from it and merge back into it."
          >
            <UInput
              v-model="defaultBranch"
              size="lg"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField label="Merge method">
            <USelectMenu
              v-model="mergeMethod"
              :items="[{ label: 'Squash and merge', value: 'squash' }, { label: 'Merge commit', value: 'merge' }, { label: 'Rebase and merge', value: 'rebase' }]"
              value-key="value"
              size="lg"
              :search-input="false"
              class="w-full"
            />
          </UFormField>
          <div class="overflow-hidden rounded-md border border-default">
            <p class="border-b border-default bg-elevated/50 px-3 py-2 text-sm font-medium">
              Setup checks for {{ picked.nameWithOwner }}
            </p>
            <div class="p-3">
              <USkeleton
                v-if="checking"
                class="h-16 w-full"
              />
              <ul
                v-else-if="check"
                class="flex flex-col gap-3 text-sm"
              >
                <li
                  v-for="c in check.checks"
                  :key="c.id"
                  class="flex items-start gap-2"
                >
                  <UIcon
                    :name="c.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                    :class="['mt-0.5 size-4 shrink-0', c.ok ? 'text-success' : 'text-error']"
                  />
                  <span><span class="block font-medium">{{ c.title }}</span><span class="block text-xs text-muted">{{ c.detail }}</span></span>
                </li>
                <li class="flex items-start gap-2">
                  <UIcon
                    name="i-lucide-info"
                    class="mt-0.5 size-4 shrink-0 text-info"
                  />
                  <span class="text-xs text-muted">Agents read .corral/ from the repository when it exists; nothing is written to the repository during setup.</span>
                </li>
              </ul>
            </div>
          </div>
        </template>
      </template>

      <template v-else-if="step === 'agents'">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="font-medium">
              Detected in the runner
            </p>
            <p class="text-xs text-muted">
              {{ clis?.filter(c => c.version).length ?? 0 }} of 3 supported CLIs found
            </p>
          </div>
          <UButton
            label="Scan again"
            variant="ghost"
            color="neutral"
            icon="i-lucide-refresh-cw"
            @click="scan"
          />
        </div>
        <UAlert
          v-if="cliError"
          color="error"
          variant="subtle"
          :title="cliError"
        />
        <USkeleton
          v-if="!clis && !cliError"
          class="h-20 w-full"
        />
        <ul class="flex flex-col gap-3">
          <li
            v-for="cli in clis ?? []"
            :key="cli.id"
            :class="['flex items-start gap-3 rounded-lg border p-3 text-sm', cli.signedIn ? 'border-primary bg-primary/10' : 'border-default']"
          >
            <UCheckbox
              :model-value="cli.signedIn"
              disabled
              size="lg"
              :aria-label="cli.name"
              class="mt-0.5"
            />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-semibold">{{ cli.name }}</span>
                <UBadge
                  :label="cli.signedIn ? 'Ready' : cli.version ? 'Not signed in' : 'Not found'"
                  :color="cli.signedIn ? 'success' : 'warning'"
                  variant="subtle"
                  size="sm"
                />
              </div>
              <p class="mt-1 text-xs break-words text-muted">
                {{ cliDetail(cli) }}
              </p>
            </div>
          </li>
          <li
            v-for="other in ['Gemini CLI']"
            :key="other"
            class="flex items-start gap-3 rounded-lg border border-default p-3 text-sm opacity-60"
          >
            <UCheckbox
              :model-value="false"
              disabled
              size="lg"
              :aria-label="other"
              class="mt-0.5"
            />
            <div class="flex-1">
              <div class="flex items-center gap-2">
                <span class="font-semibold">{{ other }}</span>
                <UBadge
                  label="Coming later"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                />
              </div>
              <p class="mt-1 text-xs text-muted">
                not found
              </p>
            </div>
          </li>
        </ul>
        <UAlert
          color="info"
          variant="subtle"
          icon="i-lucide-shield"
          title="Your credentials stay with your CLI. Corral never sees, stores or sends your model-provider login."
        />
      </template>

      <template v-else>
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="font-medium">
              Agent roles
            </p>
            <p class="text-xs text-muted">
              All three run on Claude Code for now
            </p>
          </div>
          <UButton
            label="Suggest names"
            variant="ghost"
            color="neutral"
            icon="i-lucide-sparkles"
            @click="suggest"
          />
        </div>
        <ul class="flex flex-col gap-3">
          <li
            v-for="r in ROLES"
            :key="r.role"
            class="flex flex-col gap-3 rounded-lg border border-default p-3"
          >
            <div class="flex items-center gap-3">
              <UAvatar
                :text="initials(agentNames[r.role] || r.label)"
                size="lg"
                :class="r.role === 'pm' ? 'bg-primary/15' : ''"
              />
              <div class="min-w-0 flex-1 text-sm">
                <div class="flex items-center gap-2">
                  <span class="truncate font-semibold">{{ agentNames[r.role] }}</span>
                  <UBadge
                    :label="r.label"
                    color="primary"
                    variant="subtle"
                    size="sm"
                  />
                </div>
                <p class="text-xs text-muted">
                  {{ r.description }}
                </p>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <UFormField label="Name">
                <UInput
                  v-model="agentNames[r.role]"
                  size="lg"
                  :aria-label="`${r.label} name`"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="Runs on">
                <USelectMenu
                  model-value="claude"
                  :items="[{ label: 'Claude', value: 'claude' }]"
                  value-key="value"
                  size="lg"
                  :search-input="false"
                  class="w-full"
                />
              </UFormField>
            </div>
          </li>
        </ul>
      </template>
    </main>

    <footer class="shrink-0 border-t border-default bg-default px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <UButton
        :label="adding ? 'Add project' : step === 'names' ? 'Finish setup' : step === 'agents' ? 'Confirm and continue' : 'Continue'"
        :trailing-icon="step === 'names' || adding ? 'i-lucide-check' : 'i-lucide-chevron-right'"
        :disabled="!canContinue"
        :loading="finishing || savingName"
        size="xl"
        block
        @click="next"
      />
    </footer>
  </div>
</template>
