import type { RebaseCheckFailure } from '@corral/contracts'
import { errorText } from '@corral/core'
import type { ChangedFile, GitHubClient } from './github.ts'

function isProjectDoc(path: string): boolean {
  return path === 'CORRAL.md' || path === 'CLAUDE.md' || path.startsWith('docs/') || path.startsWith('.corral/wiki/')
}

// What a file's entry in a diff changes, or null when that can't be told. The
// base moving shifts line numbers without changing the change, so hunk headers
// don't count. Binary and very large files have no patch, and the blob on the
// head side says nothing about what it replaced: A → C and B → C share it. Only
// an added file replaced nothing, so only there does the blob identify the change.
function changeOf(file: ChangedFile): string | null {
  const change = file.patch?.replace(/^@@ .*$/gm, '@@') ?? (file.status === 'added' ? file.sha : null)
  return change === null ? null : JSON.stringify([file.status, file.previousFilename ?? null, change])
}

export interface TrivialRebaseCheck {
  failures: RebaseCheckFailure[]
  // Set when the check couldn't run, so it proved nothing
  error?: string
}

// D24's server check of a developer's `trivial`. Old and new base are the
// merge bases of the approved and new heads with the base branch, so nothing
// here rests on the developer's word except the list it's checked against.
export async function checkTrivialRebase(
  github: GitHubClient,
  repository: string,
  input: { baseBranch: string, approvedHeadSha: string, newHeadSha: string, conflictedFiles: string[] }
): Promise<TrivialRebaseCheck> {
  try {
    const baseHead = await github.branchHead(repository, input.baseBranch)
    if (!baseHead) throw new Error(`Branch ${input.baseBranch} doesn't exist`)
    const approved = await github.compare(repository, baseHead, input.approvedHeadSha)
    const rebased = await github.compare(repository, baseHead, input.newHeadSha)
    const onBase = await github.compare(repository, approved.mergeBase, rebased.mergeBase)

    const before = new Map(approved.files.map(f => [f.filename, changeOf(f)]))
    const after = new Map(rebased.files.map(f => [f.filename, changeOf(f)]))
    const outside = [...new Set([...before.keys(), ...after.keys()])]
      .filter((file) => {
        const change = before.get(file)
        return (change === null || change !== after.get(file)) && !input.conflictedFiles.includes(file)
      })
    const docs = [...new Set(onBase.files.flatMap(f => [f.filename, f.previousFilename ?? f.filename]))].filter(isProjectDoc)

    const failures: RebaseCheckFailure[] = []
    if (outside.length > 0) failures.push({ condition: 'changes_outside_conflicts', files: outside.sort() })
    if (docs.length > 0) failures.push({ condition: 'project_docs_changed', files: docs.sort() })
    return { failures }
  } catch (error) {
    console.error(`Trivial rebase check for ${input.newHeadSha} failed`, error)
    return { failures: [], error: errorText(error) }
  }
}
