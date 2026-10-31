import { useMutation, useQueryClient } from '@tanstack/vue-query'
import type { CliStatus, RepoCheck, RepoChoice, RepoList } from '@corral/contracts'
import { suggestPrefix } from '~/utils/prefix'
import { ApiError, api } from '~/composables/useApi'
import { agentsQuery, patchAgent } from '~/queries/agents'
import { createProject, projectsQuery } from '~/queries/projects'
import { patchProfile, profileQuery } from '~/queries/system'
import { cliLoginCommand } from '~/utils/labels'

// Onboarding state and actions (design/onboarding.md), shared by the web
// page and SetupMobile: You → Repository → Agents → Names. With ?add=1 it's
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
  const prefix = ref('')
  const prefixConflict = ref('')
  const prefixValid = computed(() => /^[A-Z]{2,5}$/.test(prefix.value))
  const prefixError = computed(() => prefixConflict.value || (!prefixValid.value ? 'Use 2–5 letters, A–Z.' : undefined))
  function setPrefix(value: string) {
    prefix.value = value.toUpperCase().replace(/[^A-Z]/g, '')
    prefixConflict.value = ''
  }
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
      const [result, projects] = await Promise.all([api.setup.checkRepo(name), client.fetchQuery(projectsQuery())])
      if (version !== pickVersion) return
      setPrefix(suggestPrefix(name.split('/')[1] ?? name, projects.map(p => p.prefix)))
      check.value = result
      if (check.value.defaultBranch) defaultBranch.value = check.value.defaultBranch
    } catch (e) {
      if (version !== pickVersion) return
      toast.add({ title: 'Check failed', description: e instanceof Error ? e.message : String(e), color: 'error' })
    } finally {
      if (version === pickVersion) checking.value = false
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
    if (!cli.version) return `Install ${cli.name} in the runner container.`
    if (!cli.signedIn) return `${cli.version}. Sign in with: ${cliLoginCommand(cli.id)}`
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
      await router.push(`/projects/${project.slug}`)
    } catch (e) {
      if (e instanceof ApiError && e.body?.code === 'conflict' && e.body.constraint?.includes('prefix')) {
        prefixConflict.value = 'Another project uses this prefix.'
        step.value = 'repo'
        return
      }
      toast.add({ title: 'Could not finish', description: e instanceof Error ? e.message : String(e), color: 'error' })
    } finally {
      finishing.value = false
    }
  }
  async function next() {
    if (!canContinue.value || finishing.value) return
    if (adding.value && step.value === 'repo') return finish()
    if (step.value === 'names') return finish()
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

  return { adding, steps, step, index, userName, savingName, repos, reposError, repoSearch, picked, pasted, showPaste, check, checking, prefix, prefixError, setPrefix, defaultBranch, mergeMethod, loadRepos, repoRows, pick, clis, cliError, scan, cliDetail, agentNames, suggest, finishing, next, canContinue }
}

export type Setup = ReturnType<typeof useSetup>
