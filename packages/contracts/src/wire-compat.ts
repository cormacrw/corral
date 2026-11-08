import { EPIC_REVIEW_MODES, type EpicReviewMode } from '@corral/core'
import { z } from 'zod'

// Names on the wire that differ from what the server stores, and what older
// runners still send. Each shim says when it can go.

// The PM sees tasks with subtasks (D31); the server stores their delivery as an
// epic. So the `epic` review mode is `parent` on the wire, `epicId` is
// `parentId` and `epicReviewModeDefault` is `defaultReviewMode`.
export const WIRE_REVIEW_MODES = ['parent', 'each_task', 'direct'] as const
export type WireReviewMode = typeof WIRE_REVIEW_MODES[number]

export function toStoredReviewMode(mode: WireReviewMode | EpicReviewMode): EpicReviewMode {
  return mode === 'parent' ? 'epic' : mode
}

export function toWireReviewMode(mode: EpicReviewMode): WireReviewMode {
  return mode === 'epic' ? 'parent' : mode
}

const REVIEW_MODE_ERROR = `reviewMode must be one of ${WIRE_REVIEW_MODES.join(', ')}`

// A review mode the PM gives, as the server stores it
export const wireReviewModeInput = z.enum(WIRE_REVIEW_MODES).optional().transform(mode => mode && toStoredReviewMode(mode))

// The same in a proposed plan, which also takes the stored names older runners send
export const planReviewModeInput = z.enum([...EPIC_REVIEW_MODES, 'parent'], { error: REVIEW_MODE_ERROR }).optional()
  .transform(mode => mode && toStoredReviewMode(mode))
// What the PM is offered for a plan's review mode
export const advertisedPlanReviewMode = z.enum(WIRE_REVIEW_MODES, { error: REVIEW_MODE_ERROR }).optional()

// The project's field, as the server stores it
export function storedProjectFields<T extends { defaultReviewMode?: EpicReviewMode | undefined }>({ defaultReviewMode, ...fields }: T) {
  return { ...fields, ...defaultReviewMode && { epicReviewModeDefault: defaultReviewMode } }
}

// Tools runners from before parent tasks (D31) still call. Not offered to the
// PM; remove once no runner sends them.
export const LEGACY_AGENT_TOOLS = ['update_epic'] as const

// Tools whose input takes the wire names above
export const RENAMED_INPUT_TOOLS = ['create_task', 'update_task', 'update_parent', 'update_project', 'create_project'] as const

// What an older runner's call means now, and the stored field for a new one
export function neutralPmCall(tool: string, input: unknown): { tool: string, input: unknown } {
  if (!input || typeof input !== 'object') return { tool, input }
  const { epicId, epicReviewModeDefault, reviewMode, ...rest } = input as Record<string, unknown>
  const mode = (value: unknown) => value === 'epic' ? 'parent' : value
  const renamed = {
    ...rest,
    ...epicId !== undefined && { parentId: epicId },
    ...reviewMode !== undefined && { reviewMode: mode(reviewMode) },
    ...epicReviewModeDefault !== undefined && { defaultReviewMode: mode(epicReviewModeDefault) }
  }
  if (tool === 'update_epic') return { tool: 'update_parent', input: renamed }
  return (RENAMED_INPUT_TOOLS as readonly string[]).includes(tool) ? { tool, input: renamed } : { tool, input }
}

// Tool contracts of older builds that still work with this server. A change
// that keeps every old tool call valid lists the old hash here, so runners keep
// taking runs while they update. Remove it once they have.
// cccc7e25c0885c76: before COR-520, which changes descriptions only
// cc3d950e1d8050a1: before parent tasks (D31), whose PM tools only add to it
export const COMPATIBLE_TOOL_CONTRACTS: readonly string[] = ['cc3d950e1d8050a1', 'cccc7e25c0885c76']
