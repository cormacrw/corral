import { expect, it } from 'vitest'
import { runnerSlots, runnerSlotSource } from '~/features/settings/utils/runner'

it('counts slots in use only while the runner is online', () => {
  expect(runnerSlots({ online: true, slots: 4, slotsInUse: 1 })).toBe('1 of 4 slots in use')
  expect(runnerSlots({ online: false, slots: 4, slotsInUse: 0 })).toBe('4 slots')
  expect(runnerSlots({ online: false, slots: 1, slotsInUse: 0 })).toBe('1 slot')
})

it('says where the slot count came from', () => {
  expect(runnerSlotSource({ slotSource: { kind: 'explicit' } })).toBe('Set explicitly by CORRAL_RUNNER_SLOTS')
  expect(runnerSlotSource({})).toContain('Slot source unavailable')
  expect(runnerSlotSource({ slotSource: { kind: 'derived', cpus: 7.999, memoryBytes: 16 * 1024 ** 3, slotCpus: 2, slotMemoryBytes: 4 * 1024 ** 3 } }))
    .toBe('Derived from 8 CPUs and 16 GiB memory · 2 CPUs / 4 GiB per slot')
})
