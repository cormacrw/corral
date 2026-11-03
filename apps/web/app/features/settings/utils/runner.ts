import type { RunnerInfo } from '@corral/contracts'

const gib = (bytes: number) => Number((bytes / 1024 ** 3).toFixed(2))

export function runnerSlots(runner: Pick<RunnerInfo, 'online' | 'slots' | 'slotsInUse'>): string {
  if (runner.online) return `${runner.slotsInUse} of ${runner.slots} slots in use`
  return `${runner.slots} ${runner.slots === 1 ? 'slot' : 'slots'}`
}

// Where the slot count came from. Runners older than resource sizing don't say.
export function runnerSlotSource({ slotSource: source }: Pick<RunnerInfo, 'slotSource'>): string {
  if (source?.kind === 'explicit') return 'Set explicitly by CORRAL_RUNNER_SLOTS'
  if (source?.kind !== 'derived') return 'Slot source unavailable · update runner to report resources'
  return `Derived from ${Number(source.cpus.toFixed(2))} CPUs and ${gib(source.memoryBytes)} GiB memory · ${source.slotCpus} CPUs / ${gib(source.slotMemoryBytes)} GiB per slot`
}
