import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_CONTRACT, agentToolManifest, ROLE_TOOLS, toolContractHash } from './agent-tools.ts'
import { reportOutcomeInput, toolContractReason } from './index.ts'

describe('the agent tool contract', () => {
  it('covers every role\'s tools, with report_outcome\'s full input', () => {
    const manifest = agentToolManifest()
    for (const role of ['developer', 'reviewer', 'designer'] as const) {
      expect(Object.keys(manifest[role]!.tools)).toEqual(ROLE_TOOLS[role])
      expect(manifest[role]!.tools.report_outcome!.input.properties).toHaveProperty('decision')
    }
    expect(Object.keys(reportOutcomeInput.shape).sort()).toEqual(Object.keys(manifest.developer!.tools.report_outcome!.input.properties!).sort())
  })

  it('is a short hash of the manifest, which any change to a tool moves', () => {
    const manifest = agentToolManifest()
    expect(AGENT_TOOL_CONTRACT).toMatch(/^[0-9a-f]{16}$/)
    expect(toolContractHash(agentToolManifest())).toBe(AGENT_TOOL_CONTRACT)
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
