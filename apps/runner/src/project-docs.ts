import { DEFAULT_ROLE_INSTRUCTIONS } from '@corral/contracts'
import type { AgentRole } from '@corral/core'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { readIfExists } from './layout.ts'

// What the runner reads from a project's checkout for an agent's system prompt

// Role instructions live in the repo so each project can set its own rules
// (D13); the built-in text applies when the file is missing
export async function readRoleInstructions(worktree: string, role: AgentRole): Promise<string> {
  const text = await readIfExists(join(worktree, '.corral', 'agents', `${role}.md`))
  return text?.trim() || DEFAULT_ROLE_INSTRUCTIONS[role]
}

// A project's top-level docs. The brief carries the first that exists, so a
// first turn doesn't spend model calls finding them.
export const PROJECT_DOC_FILES = ['CORRAL.md', join('.corral', 'CORRAL.md'), 'CLAUDE.md']
export const MAX_BRIEF_CHARS = 20_000

async function wikiPages(worktree: string): Promise<string[]> {
  const wiki = join(worktree, '.corral', 'wiki')
  const entries = await readdir(wiki, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile())
    .map(entry => relative(wiki, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

// Always includes worktree status, even when no project docs exist.
export async function readProjectBrief(worktree: string): Promise<string> {
  let doc: { name: string, text: string } | null = null
  for (const name of PROJECT_DOC_FILES) {
    const text = await readIfExists(join(worktree, name))
    if (text?.trim()) {
      doc = { name: name.split(sep).join('/'), text: text.trim() }
      break
    }
  }
  const pages = await wikiPages(worktree)
  const [hasWiki, hasDependencies] = await Promise.all([
    stat(join(worktree, '.corral', 'wiki')).then(s => s.isDirectory(), () => false),
    stat(join(worktree, 'node_modules')).then(s => s.isDirectory(), () => false)
  ])

  const parts: string[] = []
  if (doc) parts.push(`### ${doc.name}`, '', doc.text, '')
  if (pages.length > 0) parts.push('### Wiki pages in .corral/wiki/', '', ...pages.map(page => `- ${page}`), '')
  let body = parts.join('\n').trim()
  if (body.length > MAX_BRIEF_CHARS) {
    body = `${body.slice(0, MAX_BRIEF_CHARS)}\n\n[Brief truncated: it is longer than ${MAX_BRIEF_CHARS.toLocaleString('en')} characters. Read ${doc ? doc.name : 'the files above'} for the rest if you need it.]`
  }
  const listed = [doc?.name, pages.length > 0 ? 'the .corral/wiki/ file list' : null].filter(Boolean).join(' and ')
  return [
    '## Project brief',
    '',
    `Worktree status: .corral/wiki/ ${hasWiki ? 'exists' : 'does not exist'}; dependencies (node_modules) are ${hasDependencies ? 'installed' : 'not installed'} in this worktree.`,
    '',
    listed ? `The runner has already read ${listed} from your checkout and included it below, so don't read ${doc ? 'that file' : 'it'} again. Open other files, including individual wiki pages, only when a request needs them.` : 'No project brief file (CORRAL.md, .corral/CORRAL.md or CLAUDE.md) was found.',
    '',
    body
  ].join('\n')
}
