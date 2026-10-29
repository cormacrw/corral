<script setup lang="ts">
import type { CliStatus, RepoCheck, RepoChoice, RepoList } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { initials, timeAgo } from '~/utils/labels'

// Onboarding (design/onboarding.md): You → Repository → Agents → Names.
// With ?add=1 it's the add-project flow from the sidebar (repository only).
definePageMeta({ layout: 'bare' })
useSeoMeta({ title: 'Set up Corral' })
const route = useRoute()
const router = useRouter()
const live = useLive()
const toast = useToast()
const adding = computed(() => route.query.add === '1')

const steps = [
  { title: 'You', description: 'Your name', value: 'you' },
  { title: 'Repository', description: 'Choose a repo', value: 'repo' },
  { title: 'Agents', description: 'Detect CLIs', value: 'agents' },
  { title: 'Names', description: 'Name agents', value: 'names' }
]
const step = ref<string>(adding.value ? 'repo' : (typeof route.query.step === 'string' ? route.query.step : 'you'))
watch(step, s => router.replace({ query: { ...route.query, step: s } }))
const index = computed(() => steps.findIndex(s => s.value === step.value))

// Step 1: the name is kept on the server, so any browser sees it
const userName = ref('')
onMounted(async () => {
  try {
    const profile = await api.me.get()
    if (!userName.value) userName.value = profile.name
  } catch {
    // Leave the field empty; saving reports any error
  }
})
const savingName = ref(false)
async function saveName() {
  savingName.value = true
  try {
    live.state.value.profile = await api.me.patch({ name: userName.value.trim() })
    return true
  } catch (e) {
    toast.add({ title: 'Could not save your name', description: e instanceof Error ? e.message : String(e), color: 'error' })
    return false
  } finally {
    savingName.value = false
  }
}

// Step 2
const repos = ref<RepoList | null>(null)
const reposError = ref<string | null>(null)
const repoSearch = ref('')
const picked = ref<RepoChoice | null>(null)
const pasted = ref('')
const showPaste = ref(false)
const check = ref<RepoCheck | null>(null)
const checking = ref(false)
const defaultBranch = ref('main')
const mergeMethod = ref<'squash' | 'merge' | 'rebase'>('squash')
async function loadRepos(refresh = false) {
  reposError.value = null
  try {
    repos.value = await api.setup.repos(refresh)
  } catch (e) {
    reposError.value = e instanceof Error ? e.message : String(e)
  }
}
const repoRows = computed(() => repos.value?.signedIn ? repos.value.repos.filter(r => !repoSearch.value || r.nameWithOwner.toLowerCase().includes(repoSearch.value.toLowerCase())) : [])
async function pick(repo: RepoChoice | string) {
  const name = typeof repo === 'string' ? repo : repo.nameWithOwner
  picked.value = typeof repo === 'string' ? { nameWithOwner: name, description: null, isPrivate: false, updatedAt: '', defaultBranch: 'main', selectable: true, reason: null, usedBy: null } : repo
  defaultBranch.value = picked.value.defaultBranch
  checking.value = true
  check.value = null
  try {
    check.value = await api.setup.checkRepo(name)
    if (check.value.defaultBranch) defaultBranch.value = check.value.defaultBranch
  } catch (e) {
    toast.add({ title: 'Check failed', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    checking.value = false
  }
}
watch(step, (s) => {
  if (s === 'repo' && !repos.value) void loadRepos()
  if (s === 'agents' && !clis.value) void scan()
}, { immediate: true })

// Step 3
const clis = ref<CliStatus[] | null>(null)
const cliError = ref<string | null>(null)
async function scan() {
  cliError.value = null
  try {
    clis.value = await api.setup.clis()
  } catch (e) {
    cliError.value = e instanceof Error ? e.message : String(e)
  }
}
// Claude Code runs the default agents; Codex runs only agents set to it
const cliReady = computed(() => clis.value?.some(c => c.id === 'claude' && c.signedIn) ?? false)
function cliDetail(cli: CliStatus): string {
  const command = cli.id === 'codex' ? 'codex login' : 'claude'
  if (!cli.version) return `Install ${cli.name} in the runner container.`
  if (!cli.signedIn) return `${cli.version}. Sign in with: docker exec -it corral-runner ${command}`
  return cli.id === 'claude' ? `${cli.version}. Signed in. Will run your PM, developer and reviewer agents.` : `${cli.version}. Signed in. Runs agents set to Codex.`
}

// Step 4
const nameSets = [['Juno', 'Atlas', 'Vera'], ['Iris', 'Bolt', 'Sage'], ['Nova', 'Forge', 'Echo']]
const nameSet = ref(0)
const agentNames = reactive({ pm: 'Juno', developer: 'Atlas', reviewer: 'Vera' })
function suggest() {
  nameSet.value = (nameSet.value + 1) % nameSets.length
  ;[agentNames.pm, agentNames.developer, agentNames.reviewer] = nameSets[nameSet.value] as [string, string, string]
}

const finishing = ref(false)
async function finish() {
  if (!picked.value) return
  finishing.value = true
  try {
    const name = picked.value.nameWithOwner.split('/')[1] ?? picked.value.nameWithOwner
    const prefix = name.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase().padEnd(2, 'X')
    const project = await api.projects.create({ name, prefix, repository: picked.value.nameWithOwner, defaultBranch: defaultBranch.value, mergeMethod: mergeMethod.value })
    if (!adding.value) {
      for (const agent of live.state.value.agents.length ? live.state.value.agents : await api.agents.list()) {
        const wanted = agentNames[agent.role]
        if (wanted && wanted !== agent.name) await api.agents.patch(agent.id, { name: wanted })
      }
    }
    await live.load()
    await router.push(`/projects/${project.slug}`)
  } catch (e) {
    toast.add({ title: 'Could not finish', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    finishing.value = false
  }
}
async function next() {
  if (adding.value && step.value === 'repo') return void finish()
  if (step.value === 'names') return void finish()
  if (step.value === 'you' && !await saveName()) return
  step.value = steps[index.value + 1]!.value
}
const canContinue = computed(() => {
  switch (step.value) {
    case 'you': return userName.value.trim().length > 0 && userName.value.trim().length <= 80
    case 'repo': return Boolean(picked.value && check.value?.ready)
    case 'agents': return cliReady.value
    default: return Object.values(agentNames).every(n => n.trim())
  }
})
</script>

<template>
  <div class="flex min-h-svh flex-col">
    <header class="flex h-16 items-center justify-between border-b border-default px-6">
      <span class="flex items-center gap-2 font-semibold">
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
    </header>
    <main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pt-12 pb-12">
      <UStepper
        v-if="!adding"
        v-model="step"
        :items="steps"
        linear
        class="w-full"
      />
      <div>
        <h1 class="text-2xl font-semibold">
          {{ step === 'you' ? 'Your name' : step === 'repo' ? (adding ? 'Add a project' : 'Choose a repository') : step === 'agents' ? 'Confirm agent CLIs' : 'Name your agents' }}
        </h1>
        <p class="text-sm text-muted">
          {{ step === 'you' ? 'How you appear on comments, approvals and PM questions.' : step === 'repo' ? 'Repositories the runner’s GitHub login can see, most recently updated first.' : step === 'agents' ? 'Detected inside the runner. Your credentials stay with your CLI.' : 'All three run on Claude Code for now.' }}
        </p>
      </div>

      <UCard>
        <div
          v-if="step === 'you'"
          class="flex flex-col gap-4"
        >
          <UFormField
            label="Your name"
            required
          >
            <UInput
              v-model="userName"
              size="lg"
              icon="i-lucide-user"
              placeholder="Your name"
              :maxlength="80"
            />
          </UFormField>
          <div class="flex items-center gap-3 text-sm text-muted">
            <UAvatar
              :text="initials(userName || 'You')"
              size="lg"
            />
            How you'll appear on comments, approvals and PM questions
          </div>
        </div>

        <div
          v-else-if="step === 'repo'"
          class="flex flex-col gap-4"
        >
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
              <pre class="rounded bg-elevated p-2 font-mono text-xs">docker exec -it corral-runner gh auth login</pre>
              <UButton
                label="Check again"
                size="xs"
                class="mt-2"
                @click="loadRepos(true)"
              />
            </template>
          </UAlert>
          <template v-else>
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium">Repository <span class="text-error">*</span></span>
              <UButton
                label="Refresh"
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-refresh-cw"
                @click="loadRepos(true)"
              />
            </div>
            <div class="rounded-md border border-default">
              <UInput
                v-model="repoSearch"
                :placeholder="`Search ${repos?.signedIn ? repos.repos.length : ''} repositories`"
                icon="i-lucide-search"
                variant="none"
                class="w-full border-b border-default"
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
                    :class="['flex w-full items-start gap-2 border-b border-default px-3 py-2 text-start text-sm disabled:opacity-60', picked?.nameWithOwner === repo.nameWithOwner ? 'bg-primary/10 ring-1 ring-primary ring-inset' : 'hover:bg-elevated']"
                    @click="pick(repo)"
                  >
                    <UIcon
                      :name="repo.isPrivate ? 'i-lucide-lock' : 'i-lucide-book'"
                      class="mt-0.5 size-4 shrink-0 text-muted"
                    />
                    <span class="min-w-0 flex-1">
                      <span><span class="text-muted">{{ repo.nameWithOwner.split('/')[0] }}/</span><span class="font-semibold">{{ repo.nameWithOwner.split('/')[1] }}</span>
                        <UBadge
                          :label="repo.isPrivate ? 'Private' : 'Public'"
                          size="xs"
                          variant="subtle"
                          color="neutral"
                          class="ms-2"
                        /></span>
                      <span
                        v-if="repo.description"
                        class="block truncate text-xs text-muted"
                      >{{ repo.description }}</span>
                      <span
                        v-if="repo.reason"
                        class="block text-xs text-warning"
                      >{{ repo.reason === 'read_only' ? 'Read-only access: agents couldn’t push branches or open PRs' : `Used by ${repo.usedBy?.name}` }}</span>
                    </span>
                    <span class="shrink-0 text-end text-xs text-muted">
                      Updated {{ timeAgo(repo.updatedAt) }}<br><span class="font-mono">{{ repo.defaultBranch }}</span>
                    </span>
                    <UIcon
                      v-if="picked?.nameWithOwner === repo.nameWithOwner"
                      name="i-lucide-check"
                      class="size-4 text-primary"
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
            <div class="text-sm">
              <UButton
                label="Can't find it? Paste a GitHub URL"
                variant="link"
                size="xs"
                @click="showPaste = !showPaste"
              />
              <form
                v-if="showPaste"
                class="mt-2 flex gap-2"
                @submit.prevent="pick(pasted.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, ''))"
              >
                <UInput
                  v-model="pasted"
                  placeholder="https://github.com/owner/name"
                  class="flex-1"
                />
                <UButton
                  type="submit"
                  label="Check access"
                  variant="outline"
                  color="neutral"
                />
              </form>
            </div>
          </template>

          <template v-if="picked">
            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField
                label="Default branch"
                help="From GitHub. Agents branch from it and merge back into it."
              >
                <UInput v-model="defaultBranch" />
              </UFormField>
              <UFormField label="Merge method">
                <USelectMenu
                  v-model="mergeMethod"
                  :items="[{ label: 'Squash and merge', value: 'squash' }, { label: 'Merge commit', value: 'merge' }, { label: 'Rebase and merge', value: 'rebase' }]"
                  value-key="value"
                  :search-input="false"
                />
              </UFormField>
            </div>
            <div>
              <p class="mb-1 text-sm font-medium">
                Setup checks for {{ picked.nameWithOwner }}
              </p>
              <USkeleton
                v-if="checking"
                class="h-16 w-full"
              />
              <ul
                v-else-if="check"
                class="flex flex-col gap-1 text-sm"
              >
                <li
                  v-for="c in check.checks"
                  :key="c.id"
                  class="flex items-start gap-2"
                >
                  <UIcon
                    :name="c.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                    :class="['mt-0.5 size-4', c.ok ? 'text-success' : 'text-error']"
                  />
                  <span><span class="font-medium">{{ c.title }}</span> <span class="text-muted">{{ c.detail }}</span></span>
                </li>
                <li class="flex items-start gap-2">
                  <UIcon
                    name="i-lucide-info"
                    class="mt-0.5 size-4 text-info"
                  />
                  <span class="text-muted">Agents read .corral/ from the repository when it exists; nothing is written to the repository during setup.</span>
                </li>
              </ul>
            </div>
          </template>
        </div>

        <div
          v-else-if="step === 'agents'"
          class="flex flex-col gap-4"
        >
          <div class="flex items-center justify-between">
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
              size="xs"
              variant="ghost"
              color="neutral"
              @click="scan"
            />
          </div>
          <UAlert
            v-if="cliError"
            color="error"
            variant="subtle"
            :title="cliError"
          />
          <ul class="flex flex-col gap-2">
            <li
              v-for="cli in clis ?? []"
              :key="cli.id"
              class="flex items-center gap-3 rounded-md border border-default p-3 text-sm"
            >
              <UCheckbox
                :model-value="cli.signedIn"
                disabled
                :aria-label="cli.name"
              />
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-medium">{{ cli.name }}</span>
                  <UBadge
                    :label="cli.signedIn ? 'Ready' : cli.version ? 'Not signed in' : 'Not found'"
                    :color="cli.signedIn ? 'success' : 'warning'"
                    variant="subtle"
                    size="xs"
                  />
                </div>
                <p class="text-xs text-muted">
                  {{ cliDetail(cli) }}
                </p>
              </div>
            </li>
            <li
              v-for="other in ['Gemini CLI']"
              :key="other"
              class="flex items-center gap-3 rounded-md border border-default p-3 text-sm opacity-60"
            >
              <UCheckbox
                :model-value="false"
                disabled
                :aria-label="other"
              />
              <span class="flex-1 font-medium">{{ other }} <span class="text-xs font-normal text-muted">not found</span></span>
              <UBadge
                label="Coming later"
                color="neutral"
                variant="subtle"
                size="xs"
              />
            </li>
          </ul>
          <UAlert
            color="info"
            variant="subtle"
            icon="i-lucide-shield"
            title="Your credentials stay with your CLI. Corral never sees, stores or sends your model-provider login."
          />
        </div>

        <div
          v-else
          class="flex flex-col gap-4"
        >
          <div class="flex items-center justify-between">
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
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-sparkles"
              @click="suggest"
            />
          </div>
          <ul class="flex flex-col gap-3">
            <li
              v-for="role in (['pm', 'developer', 'reviewer'] as const)"
              :key="role"
              class="flex items-center gap-3 rounded-md border border-default p-3"
            >
              <UAvatar :text="initials(agentNames[role])" />
              <div class="flex-1 text-sm">
                <div class="flex items-center gap-2">
                  <span class="font-medium">{{ agentNames[role] }}</span>
                  <UBadge
                    :label="role === 'pm' ? 'PM' : role === 'developer' ? 'Developer' : 'Reviewer'"
                    color="primary"
                    variant="subtle"
                    size="xs"
                  />
                </div>
                <p class="text-xs text-muted">
                  {{ role === 'pm' ? 'Plans work with you and proposes tasks.' : role === 'developer' ? 'Implements tasks and opens PRs with evidence.' : 'Verifies changes against the acceptance criteria.' }}
                </p>
              </div>
              <UFormField
                label="Name"
                size="xs"
              >
                <UInput
                  v-model="agentNames[role]"
                  size="xs"
                />
              </UFormField>
              <UFormField
                label="Runs on"
                size="xs"
              >
                <USelectMenu
                  model-value="claude"
                  :items="[{ label: 'Claude Code', value: 'claude' }]"
                  value-key="value"
                  size="xs"
                  :search-input="false"
                />
              </UFormField>
            </li>
          </ul>
        </div>

        <template #footer>
          <div class="flex items-center justify-between">
            <UButton
              label="Back"
              variant="outline"
              color="neutral"
              :disabled="index === 0 || adding"
              @click="step = steps[index - 1]!.value"
            />
            <UButton
              :label="adding ? 'Add project' : step === 'names' ? 'Finish setup' : step === 'agents' ? 'Confirm and continue' : 'Continue'"
              :trailing-icon="step === 'names' || adding ? 'i-lucide-check' : 'i-lucide-arrow-right'"
              :disabled="!canContinue"
              :loading="finishing || savingName"
              @click="next"
            />
          </div>
        </template>
      </UCard>
    </main>
  </div>
</template>
