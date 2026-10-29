import { describe, expect, it } from 'vitest'
import { agentEnv } from './agent.ts'

describe('agentEnv', () => {
  it('keeps GitHub tokens and pushing from the agent', () => {
    const env = agentEnv({ PATH: '/usr/bin', GH_TOKEN: 'secret', GIT_CONFIG_KEY_3: 'x' })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GIT_CONFIG_KEY_3).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_0).toBe('no-push://corral-pushes-for-you')
  })

  it('leaves out the runner\'s own Corral settings', () => {
    const env = agentEnv({
      PATH: '/usr/bin',
      CORRAL_SERVER_URL: 'http://server:4100',
      CORRAL_RUNNER_DATA_DIR: '/data/runner',
      CORRAL_RUNNER_NAME: 'home-server'
    })
    expect(Object.keys(env).filter(key => key.startsWith('CORRAL_'))).toEqual([])
  })
})
