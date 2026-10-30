import { describe, expect, it } from 'vitest'
import { detectResources } from './resources.ts'
import { slotCapacity } from './config.ts'

const gib = 1024 ** 3
const host = { cpus: 32, memoryBytes: 64 * gib }
const reader = (files: Record<string, string>) => async (path: string) => files[path] ?? ''

describe('resource-based capacity', () => {
  it.each([[8, 10, 4], [8, 4, 1], [32, 64, 16], [1, 1, 1]])('advertises %s CPUs / %s GiB as %s slots', (cpus, memory, slots) => {
    expect(slotCapacity({}, { cpus, memoryBytes: memory * gib }).slots).toBe(slots)
  })
  it('honours an explicit override even with invalid budgets', () => {
    expect(slotCapacity({ CORRAL_RUNNER_SLOTS: '7', CORRAL_SLOT_CPUS: 'bad' }, { cpus: 1, memoryBytes: gib })).toEqual({ slots: 7, slotSource: { kind: 'explicit' } })
  })
  it('supports fractional CPU and memory budgets', () => {
    expect(slotCapacity({ CORRAL_SLOT_CPUS: '0.5', CORRAL_SLOT_MEMORY: '512M' }, { cpus: 2, memoryBytes: 2 * gib }).slots).toBe(4)
  })
  it.each(['0', '-2g', 'Infinity', 'junk'])('rejects invalid memory %s', (value) => {
    expect(() => slotCapacity({ CORRAL_SLOT_MEMORY: value }, host)).toThrow(/CORRAL_SLOT_MEMORY/)
  })
  it.each(['0', '-1', 'Infinity', 'junk'])('rejects invalid CPUs %s', (value) => {
    expect(() => slotCapacity({ CORRAL_SLOT_CPUS: value }, host)).toThrow(/CORRAL_SLOT_CPUS/)
  })
  it('uses host resources when cgroups are unavailable', async () => {
    expect(await detectResources(reader({}), host)).toEqual(host)
  })
  it('reads v2 nested limits and the tighter parent', async () => {
    expect(await detectResources(reader({
      '/proc/self/cgroup': '0::/agents/runner',
      '/proc/self/mountinfo': '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
      '/sys/fs/cgroup/agents/runner/cpu.max': '800000 100000',
      '/sys/fs/cgroup/agents/runner/memory.max': String(10 * gib),
      '/sys/fs/cgroup/agents/cpu.max': '400000 100000',
      '/sys/fs/cgroup/agents/memory.max': String(4 * gib),
      '/sys/fs/cgroup/cpu.max': 'max 100000',
      '/sys/fs/cgroup/memory.max': 'max'
    }), host)).toEqual({ cpus: 4, memoryBytes: 4 * gib })
  })
  it('reads namespaced v1 CPU and memory controllers', async () => {
    expect(await detectResources(reader({
      '/proc/self/cgroup': '2:cpu,cpuacct:/\n3:memory:/',
      '/proc/self/mountinfo': '1 0 0:1 /docker/abc /cg/cpu rw - cgroup cgroup rw,cpu,cpuacct\n2 0 0:2 /docker/abc /cg/memory rw - cgroup cgroup rw,memory',
      '/cg/cpu/cpu.cfs_quota_us': '150000',
      '/cg/cpu/cpu.cfs_period_us': '100000',
      '/cg/memory/memory.limit_in_bytes': String(4 * gib)
    }), host)).toEqual({ cpus: 1.5, memoryBytes: 4 * gib })
  })
  it('keeps affinity and host memory when cgroups are unlimited', async () => {
    expect(await detectResources(reader({
      '/proc/self/cgroup': '0::/',
      '/proc/self/mountinfo': '1 0 0:1 / /cg rw - cgroup2 cgroup rw',
      '/cg/cpu.max': 'max 100000',
      '/cg/memory.max': 'max'
    }), host)).toEqual(host)
  })
})
