import { readFile } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { dirname, join } from 'node:path'

export interface Resources { cpus: number, memoryBytes: number }

// Read quota limits at every visible ancestor: containers can inherit a tighter
// parent limit. availableParallelism also accounts for the process CPU affinity.
export async function detectResources(read: (path: string) => Promise<string> = readOptional, host: Resources = { cpus: availableParallelism(), memoryBytes: totalmem() }): Promise<Resources> {
  const resources = { ...host }
  const [membership, mounts] = await Promise.all([read('/proc/self/cgroup'), read('/proc/self/mountinfo')])
  for (const line of mounts.split('\n')) {
    const [left, right] = line.split(' - ')
    if (!left || !right) continue
    const [fs, , options] = right.split(' ')
    if (fs !== 'cgroup2' && fs !== 'cgroup') continue
    const fields = left.split(' ')
    const root = fields[3]!
    const mount = fields[4]!
    const entry = membership.split('\n').map(l => l.split(':')).find(e => fs === 'cgroup2' ? e[0] === '0' : e[1]?.split(',').some(c => options?.split(',').includes(c)))
    const path = entry?.[2]
    if (!path) continue
    // A cgroup namespace can expose '/' even when mountinfo names a host root.
    const relative = path === '/' ? '' : root === '/' ? path : path === root ? '' : path.startsWith(`${root}/`) ? path.slice(root.length) : null
    if (relative === null) continue
    let directory = join(mount, relative)
    while (true) {
      if (fs === 'cgroup2') {
        const [quota, period] = (await read(join(directory, 'cpu.max'))).trim().split(/\s+/).map(Number)
        limit(resources, 'cpus', quota! / period!)
        limit(resources, 'memoryBytes', Number((await read(join(directory, 'memory.max'))).trim()))
      } else {
        const [quota, period, memory] = await Promise.all(['cpu.cfs_quota_us', 'cpu.cfs_period_us', 'memory.limit_in_bytes'].map(f => read(join(directory, f))))
        limit(resources, 'cpus', Number(quota) / Number(period))
        limit(resources, 'memoryBytes', Number(memory))
      }
      if (directory === mount) break
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return resources
}

function limit(resources: Resources, key: keyof Resources, value: number) {
  if (Number.isFinite(value) && value > 0) resources[key] = Math.min(resources[key], value)
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
