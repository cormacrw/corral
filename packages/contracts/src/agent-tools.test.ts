import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_CONTRACT, agentToolManifest, toolContractHash } from './agent-tools.ts'
import { neutralPmCall, reportOutcomeInput, toolContractReason } from './index.ts'

describe('the agent tool contract', () => {
  it('gives every role report_outcome\'s full input', () => {
    const manifest = agentToolManifest()
    for (const role of ['developer', 'reviewer', 'designer'] as const) {
      expect(manifest[role]!.tools.report_outcome!.input.properties).toHaveProperty('decision')
    }
    expect(Object.keys(reportOutcomeInput.shape).sort()).toEqual(Object.keys(manifest.developer!.tools.report_outcome!.input.properties!).sort())
  })

  it('is a short hash of the manifest, which any change to a tool moves', () => {
    const manifest = agentToolManifest()
    expect(AGENT_TOOL_CONTRACT).toMatch(/^[0-9a-f]{16}$/)
    const old = structuredClone(manifest)
    delete old.developer!.tools.report_outcome!.input.properties!.decision
    expect(toolContractHash(old)).not.toBe(AGENT_TOOL_CONTRACT)
  })

  it('says why a runner differs, including one too old to say', () => {
    expect(toolContractReason('abc', 'abc')).toBeNull()
    expect(toolContractReason('old', 'new')).toContain('(old)')
    expect(toolContractReason(undefined, 'new')).toContain('from before tool contracts')
  })
})

describe('what the PM is told', () => {
  const pm = JSON.stringify(agentToolManifest().pm)

  it('names parents, not the older names runners still send', () => {
    expect(pm).toContain('update_parent')
    expect(pm).toContain('parentId')
    expect(pm).not.toMatch(/\bupdate_epic\b|\bepicId\b|"epics"|epicReviewModeDefault/)
    expect(pm.replaceAll('corral/epic-', '')).not.toMatch(/\b[Ee]pics?\b/)
  })

  it('reads an older call as the new one', () => {
    expect(neutralPmCall('update_epic', { epicId: 'e', title: 'T' })).toEqual({ tool: 'update_parent', input: { title: 'T', parentId: 'e' } })
    expect(neutralPmCall('update_task', { taskRef: 'A-1', epicId: 'e' })).toEqual({ tool: 'update_task', input: { taskRef: 'A-1', parentId: 'e' } })
  })
})
