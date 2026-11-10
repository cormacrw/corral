import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_CONTRACT, agentToolManifest, toolContractHash } from './agent-tools.ts'
import { reportOutcomeInput, toolContractReason } from './index.ts'

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

  it('says why a runner differs', () => {
    expect(toolContractReason('abc', 'abc')).toBeNull()
    expect(toolContractReason('old', 'new')).toContain('(old)')
  })
})

describe('what the PM is told', () => {
  const pm = JSON.stringify(agentToolManifest().pm)

  it('names parents, not the older epic names', () => {
    expect(pm).toContain('update_parent')
    expect(pm).toContain('parentId')
    expect(pm).not.toMatch(/\bupdate_epic\b|\bepicId\b|"epics"|epicReviewModeDefault/)
    expect(pm.replaceAll('corral/epic-', '')).not.toMatch(/\b[Ee]pics?\b/)
  })
})
