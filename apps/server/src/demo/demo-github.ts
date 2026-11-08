import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MergeMethod } from '@corral/core'
import { FakeGitHub, type FakeGitHubSnapshot } from '../fake-github.ts'

// The GitHub a demo instance talks to (`pnpm dev:demo`): the fake, loaded from
// and saved to a JSON file in the data dir, so seeded PRs, diffs and checks
// are still there after a restart and nothing reaches real GitHub.

// A commit SHA that looks like one, stable for the same seed
export function demoSha(seed: string): string {
  return createHash('sha1').update(seed).digest('hex')
}

const file = (dataDir: string) => join(dataDir, 'demo-github.json')

export class DemoGitHub extends FakeGitHub {
  // Saved after every change once set
  readonly dataDir: string | null

  constructor(dataDir: string | null = null) {
    super()
    this.dataDir = dataDir
  }

  static load(dataDir: string): DemoGitHub {
    const github = new DemoGitHub(dataDir)
    try {
      github.restore(JSON.parse(readFileSync(file(dataDir), 'utf8')) as FakeGitHubSnapshot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return github
  }

  save(dataDir = this.dataDir): void {
    // The call log would grow forever
    this.calls.length = 0
    if (!dataDir) return
    writeFileSync(`${file(dataDir)}.tmp`, JSON.stringify(this.snapshot()))
    renameSync(`${file(dataDir)}.tmp`, file(dataDir))
  }

  // Each merge gets its own commit, so release notes can tell merged tasks apart
  override async merge(repository: string, number: number, method: MergeMethod, expectedHeadSha: string) {
    this.mergeResult = { merged: true, sha: demoSha(`merge-${randomUUID()}`), message: 'Pull Request successfully merged' }
    return super.merge(repository, number, method, expectedHeadSha)
  }

  protected override changed(): void {
    this.save()
  }
}
