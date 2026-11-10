import type { EpicReviewMode } from '@corral/core'
import { z } from 'zod'

// Names on the wire that differ from what the server stores

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

// What the PM is offered for a plan's review mode
export const advertisedPlanReviewMode = z.enum(WIRE_REVIEW_MODES, { error: REVIEW_MODE_ERROR }).optional()
// The same, as the server stores it
export const planReviewModeInput = advertisedPlanReviewMode.transform(mode => mode && toStoredReviewMode(mode))

// The project's field, as the server stores it
export function storedProjectFields<T extends { defaultReviewMode?: EpicReviewMode | undefined }>({ defaultReviewMode, ...fields }: T) {
  return { ...fields, ...defaultReviewMode && { epicReviewModeDefault: defaultReviewMode } }
}
