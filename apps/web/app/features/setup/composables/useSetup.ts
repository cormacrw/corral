import { prefixTaken } from '~/queries/client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { CliStatus, RepoCheck, RepoChoice } from '@corral/contracts'
import { cliLoginCommand } from '@corral/contracts/client'
import { errorText, type MergeMethod, PROJECT_PREFIX_HINT, PROJECT_PREFIX_PATTERN } from '@corral/core'
import { suggestPrefix } from '~/utils/prefix'
import { agentsQuery, patchAgent } from '~/queries/agents'
import { createProject, projectsQuery } from '~/queries/projects'
import { checkRepo, refreshRepos, reposQuery } from '~/queries/setup'
import { patchProfile, profileQuery } from '~/queries/system'
import { repoFromUrl } from '~/features/setup/utils/onboarding'
import { useCliScan } from '~/features/setup/composables/useCliScan'
import { projectPath, SECTIONS } from '~/utils/routes'

// Onboarding state and actions (design/onboarding.md), shared by SetupDesktop
// and SetupMobile: You → Repository → Agents → Names. With ?add=1 it's
// the add-project flow from the sidebar (repository only).
export function useSetup() {
  const route = useRoute()
  const router = useRouter()
  const client = useQueryClient()
  const profileMutation = useMutation(patchProfile)
  const projectMutation = useMutation(createProject)
  const agentMutation = useMutation(patchAgent)
  const toast = useToast()
  const adding = computed(() => route.query.add === '1')

  const steps = [
    { title: 'You', description: 'Your name', value: 'you', heading: 'Your name', subheading: 'How you appear on comments, approvals and PM questions.' },
    { title: 'Repository', description: 'Choose a repo', value: 'repo', heading: 'Choose a repository', subheading: 'Repositories the runner’s GitHub login can see, most recently updated first.' },
    { title: 'Agents', description: 'Detect CLIs', value: 'agents', heading: 'Confirm agent CLIs', subheading: 'Detected inside the runner. Your credentials stay with your CLI.' },
    { title: 'Names', description: 'Name agents', value: 'names', heading: 'Name your agents', subheading: 'All three run on Claude for now. Add Codex agents later in Settings.' }
  ]
  const step = ref<string>(adding.value ? 'repo' : (typeof route.query.step === 'string' ? route.query.step : 'you'))
  watch(step, s => router.replace({ query: { ...route.query, step: s } }))
  const index = computed(() => steps.findIndex(s => s.value === step.value))
  const heading = computed(() => adding.value ? 'Add a project' : steps[index.value]?.heading ?? 'Set up Corral')
  const subheading = computed(() => steps[index.value]?.subheading)
  const finalStep = computed(() => adding.value || step.value === 'names')
  const continueLabel = computed(() => {
    if (adding.value) return 'Add project'
    if (step.value === 'names') return 'Finish setup'
    return step.value === 'agents' ? 'Confirm and continue' : 'Continue'
  })
  function back() {
    if (adding.value) return void navigateTo(SECTIONS.projects.to)
    if (index.value > 0) step.value = steps[index.value - 1]!.value
  }

  // The name is kept on the server, so any browser sees it
  const userName = ref('')
  onMounted(async () => {
    try {
      const profile = await client.fetchQuery(profileQuery())
      if (!userName.value) userName.value = profile.name
    } catch {
      // Leave the field empty; saving reports any error
    }
  })
  const savingName = ref(false)
  async function saveName() {
    savingName.value = true
    try {
      await profileMutation.mutateAsync({ name: userName.value.trim() })
      return true
    } catch (e) {
      toast.add({ title: 'Could not save your name', description: errorText(e), color: 'error' })
      return false
    } finally {
      savingName.value = false
    }
  }

  const reposList = useQuery(computed(() => ({ ...reposQuery(), enabled: step.value === 'repo' })))
  const repoRefresh = useMutation(refreshRepos)
  const repos = computed(() => reposList.data.value ?? null)
  const reposError = computed(() => (repoRefresh.error.value ?? reposList.error.value)?.message ?? null)
  const repoSearch = ref('')
  const picked = ref<RepoChoice | null>(null)
  const pasted = ref('')
  const showPaste = ref(false)
  const check = ref<RepoCheck | null>(null)
  const checking = ref(false)
  const prefix = ref('')
  const prefixConflict = ref('')
  const prefixValid = computed(() => PROJECT_PREFIX_PATTERN.test(prefix.value))
  const prefixError = computed(() => prefixConflict.value || (!prefixValid.value ? PROJECT_PREFIX_HINT : undefined))
  function setPrefix(value: string) {
    prefix.value = value.toUpperCase().replace(/[^A-Z]/g, '')
    prefixConflict.value = ''
  }
  const defaultBranch = ref('main')
  const mergeMethod = ref<MergeMethod>('squash')
  // Asks GitHub again, past the server's cached list; `error` reports a failure
  const loadRepos = () => repoRefresh.mutateAsync().catch(() => {})
  const pickPasted = () => pick(repoFromUrl(pasted.value))
  const repoRows = computed(() => repos.value?.signedIn ? repos.value.repos.filter(r => !repoSearch.value || r.nameWithOwner.toLowerCase().includes(repoSearch.value.toLowerCase())) : [])
  let pickVersion = 0
  async function pick(repo: RepoChoice | string) {
    const version = ++pickVersion
    const name = typeof repo === 'string' ? repo : repo.nameWithOwner
    picked.value = typeof repo === 'string' ? { nameWithOwner: name, description: null, isPrivate: false, updatedAt: '', defaultBranch: 'main', selectable: true, reason: null, usedBy: null } : repo
    setPrefix('')
    defaultBranch.value = picked.value.defaultBranch
    checking.value = true
    check.value = null
    try {
      const [result, projects] = await Promise.all([checkRepo(name), client.fetchQuery(projectsQuery())])
      if (version !== pickVersion) return
      setPrefix(suggestPrefix(name.split('/')[1] ?? name, projects.map(p => p.prefix)))
      check.value = result
      if (check.value.defaultBranch) defaultBranch.value = check.value.defaultBranch
    } catch (e) {
      if (version !== pickVersion) return
      toast.add({ title: 'Check failed', description: errorText(e), color: 'error' })
    } finally {
      if (version === pickVersion) checking.value = false
    }
  }

  const { clis, cliError, scan } = useCliScan(() => step.value === 'agents')
  // Claude Code runs the default agents; Codex runs only agents set to it
  const cliReady = computed(() => clis.value?.some(c => c.id === 'claude' && c.signedIn) ?? false)
  function cliDetail(cli: CliStatus): string {
    if (!cli.version) return `Install ${cli.name} in the runner container.`
    if (!cli.signedIn) return `${cli.version}. Sign in with: ${cliLoginCommand(cli.id)}`
    return cli.id === 'claude' ? `${cli.version}. Signed in. Will run your PM, developer and reviewer agents.` : `${cli.version}. Signed in. Runs agents set to Codex.`
  }

  const nameSets = [['Juno', 'Atlas', 'Vera'], ['Iris', 'Bolt', 'Sage'], ['Nova', 'Forge', 'Echo']]
  const nameSet = ref(0)
  const agentNames = reactive({ pm: 'Juno', developer: 'Atlas', reviewer: 'Vera' })
  function suggest() {
    nameSet.value = (nameSet.value + 1) % nameSets.length
    ;[agentNames.pm, agentNames.developer, agentNames.reviewer] = nameSets[nameSet.value] as [string, string, string]
  }

  const finishing = ref(false)
  async function finish() {
    if (!picked.value || !prefixValid.value || prefixConflict.value || finishing.value) return
    finishing.value = true
    try {
      const name = picked.value.nameWithOwner.split('/')[1] ?? picked.value.nameWithOwner
      const project = await projectMutation.mutateAsync({ name, prefix: prefix.value, repository: picked.value.nameWithOwner, defaultBranch: defaultBranch.value, mergeMethod: mergeMethod.value })
      if (!adding.value) {
        for (const agent of await client.ensureQueryData(agentsQuery())) {
          const wanted = agent.role === 'designer' ? undefined : agentNames[agent.role]
          if (wanted && wanted !== agent.name) await agentMutation.mutateAsync({ id: agent.id, input: { name: wanted } })
        }
      }
      await router.push(projectPath(project.slug))
    } catch (e) {
      const conflict = prefixTaken(e)
      if (conflict) {
        prefixConflict.value = conflict
        step.value = 'repo'
        return
      }
      toast.add({ title: 'Could not finish', description: errorText(e), color: 'error' })
    } finally {
      finishing.value = false
    }
  }
  async function next() {
    if (!canContinue.value || finishing.value) return
    if (finalStep.value) return finish()
    if (step.value === 'you' && !await saveName()) return
    step.value = steps[index.value + 1]!.value
  }
  const canContinue = computed(() => {
    switch (step.value) {
      case 'you': return userName.value.trim().length > 0 && userName.value.trim().length <= 80
      case 'repo': return Boolean(picked.value && check.value?.ready && !checking.value && prefixValid.value && !prefixConflict.value)
      case 'agents': return cliReady.value
      default: return prefixValid.value && !prefixConflict.value && Object.values(agentNames).every(n => n.trim())
    }
  })

  const busy = computed(() => finishing.value || savingName.value)

  return { adding, steps, step, index, heading, subheading, finalStep, continueLabel, back, userName, repos, reposError, repoSearch, picked, pasted, showPaste, check, checking, prefix, prefixError, setPrefix, defaultBranch, mergeMethod, loadRepos, repoRows, pick, pickPasted, clis, cliError, scan, cliDetail, agentNames, suggest, busy, next, canContinue }
}

export type Setup = ReturnType<typeof useSetup>
