import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSkills, pinnedSkillsDir, skillTargets } from './skills.ts'

describe('skillTargets', () => {
  it('falls back to ~/.claude/skills and ~/.codex/skills under HOME', () => {
    expect(skillTargets({ HOME: '/home/someone' })).toEqual([
      { cli: 'claude', dir: '/home/someone/.claude/skills' },
      { cli: 'codex', dir: '/home/someone/.codex/skills' }
    ])
  })

  it('uses CLAUDE_CONFIG_DIR and CODEX_HOME when they are set', () => {
    expect(skillTargets({ HOME: '/home/someone', CLAUDE_CONFIG_DIR: '/config/claude', CODEX_HOME: '/config/codex' })).toEqual([
      { cli: 'claude', dir: '/config/claude/skills' },
      { cli: 'codex', dir: '/config/codex/skills' }
    ])
  })

  it('uses the OS home directory when HOME is unset', () => {
    expect(skillTargets({})[0]?.dir).toBe(join(homedir(), '.claude', 'skills'))
  })
})

describe('installSkills', () => {
  let home: string
  let warnings: string[]
  const warn = (message: string) => warnings.push(message)

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'corral-skills-'))
    warnings = []
  })

  afterEach(async () => {
    await chmod(join(home, '.codex'), 0o755).catch(() => {})
    await rm(home, { recursive: true, force: true })
  })

  it('writes the pinned grill-me skill for both CLIs, creating the directories', async () => {
    await installSkills(pinnedSkillsDir, skillTargets({ HOME: home }), warn)

    const pinned = await readFile(join(pinnedSkillsDir, 'grill-me', 'SKILL.md'), 'utf8')
    expect(pinned).toMatch(/^name: grill-me$/m)
    expect(await readFile(join(home, '.claude', 'skills', 'grill-me', 'SKILL.md'), 'utf8')).toBe(pinned)
    expect(await readFile(join(home, '.codex', 'skills', 'grill-me', 'SKILL.md'), 'utf8')).toBe(pinned)
    expect(await readFile(join(home, '.claude', 'skills', 'grilling', 'SKILL.md'), 'utf8')).toMatch(/^name: grilling$/m)
    expect(warnings).toEqual([])
  })

  it('does not install the notes beside the skill directories', async () => {
    await installSkills(pinnedSkillsDir, skillTargets({ HOME: home }), warn)

    await expect(stat(join(home, '.claude', 'skills', 'UPSTREAM.md'))).rejects.toThrow()
    await expect(stat(join(home, '.claude', 'skills', 'LICENSE'))).rejects.toThrow()
  })

  it('only rewrites a skill file when its contents differ', async () => {
    const targets = skillTargets({ HOME: home })
    await installSkills(pinnedSkillsDir, targets, warn)
    const claudeSkill = join(home, '.claude', 'skills', 'grill-me', 'SKILL.md')
    const codexSkill = join(home, '.codex', 'skills', 'grill-me', 'SKILL.md')
    const unchangedAt = (await stat(claudeSkill)).mtimeMs
    await writeFile(codexSkill, 'edited by hand\n')
    // Make any rewrite show up in the modification time
    await new Promise(done => setTimeout(done, 20))

    await installSkills(pinnedSkillsDir, targets, warn)

    expect((await stat(claudeSkill)).mtimeMs).toBe(unchangedAt)
    expect(await readFile(codexSkill, 'utf8')).toBe(await readFile(join(pinnedSkillsDir, 'grill-me', 'SKILL.md'), 'utf8'))
  })

  it('leaves other skills and files in the directories alone', async () => {
    const skills = join(home, '.claude', 'skills')
    await mkdir(join(skills, 'my-skill'), { recursive: true })
    await writeFile(join(skills, 'my-skill', 'SKILL.md'), 'mine\n')
    await writeFile(join(skills, 'notes.txt'), 'notes\n')
    await mkdir(join(skills, 'grill-me'), { recursive: true })
    await writeFile(join(skills, 'grill-me', 'extra.md'), 'extra\n')

    await installSkills(pinnedSkillsDir, skillTargets({ HOME: home }), warn)

    expect(await readFile(join(skills, 'my-skill', 'SKILL.md'), 'utf8')).toBe('mine\n')
    expect(await readFile(join(skills, 'notes.txt'), 'utf8')).toBe('notes\n')
    expect(await readFile(join(skills, 'grill-me', 'extra.md'), 'utf8')).toBe('extra\n')
  })

  it.skipIf(process.getuid?.() === 0)('warns about a directory it cannot write and still installs the others', async () => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await chmod(join(home, '.codex'), 0o555)

    await installSkills(pinnedSkillsDir, skillTargets({ HOME: home }), warn)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`could not install skills for codex in ${join(home, '.codex', 'skills')}`)
    expect(await readFile(join(home, '.claude', 'skills', 'grill-me', 'SKILL.md'), 'utf8')).toMatch(/^name: grill-me$/m)
  })
})
