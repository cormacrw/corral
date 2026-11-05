import { beforeEach, describe, expect, it } from 'vitest'
import { recordAppHistoryPosition, resetAppHistory, stepsToAppStart } from '~/utils/app-history'

beforeEach(() => resetAppHistory())

describe('app history start', () => {
  it('lowers the start when Back lands on an earlier Corral entry', () => {
    recordAppHistoryPosition(3)
    recordAppHistoryPosition(1)
    recordAppHistoryPosition(4)
    expect(stepsToAppStart(4)).toBe(3)
  })

  it('counts no steps before anything is recorded or for an unknown position', () => {
    expect(stepsToAppStart(4)).toBe(0)
    recordAppHistoryPosition(2)
    expect(stepsToAppStart(undefined)).toBe(0)
    expect(stepsToAppStart(1)).toBe(0)
  })
})
