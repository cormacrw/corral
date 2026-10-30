import { describe, expect, it } from 'vitest'
import { onboardingRedirect } from './onboarding.ts'

const one = [{ slug: 'test-app' }]
const at = (path: string, query: Record<string, string> = {}) => ({ path, query })

describe('onboardingRedirect', () => {
  it('opens Home on mobile once onboarding is complete', () => {
    expect(onboardingRedirect(at('/'), one, 'mobile')).toBe('/home')
    expect(onboardingRedirect(at('/setup'), one, 'mobile')).toBe('/home')
    expect(onboardingRedirect(at('/setup/you'), one, 'mobile')).toBe('/home')
    expect(onboardingRedirect(at('/setup', { add: '1' }), one, 'mobile')).toBeUndefined()
    expect(onboardingRedirect(at('/'), [], 'mobile')).toBe('/setup')
    expect(onboardingRedirect(at('/'), null, 'mobile')).toBeUndefined()
  })

  it('sends / to the first project once the server has one', () => {
    expect(onboardingRedirect(at('/'), one)).toBe('/projects/test-app')
    expect(onboardingRedirect(at('/'), [{ slug: 'a' }, { slug: 'b' }])).toBe('/projects/a')
  })

  it('sends the wizard to the first project once the server has one', () => {
    expect(onboardingRedirect(at('/setup'), one)).toBe('/projects/test-app')
    expect(onboardingRedirect(at('/setup', { step: 'you' }), one)).toBe('/projects/test-app')
    expect(onboardingRedirect(at('/setup', { step: 'repo' }), one)).toBe('/projects/test-app')
  })

  it('keeps the add-project flow open when projects exist', () => {
    expect(onboardingRedirect(at('/setup', { step: 'repo', add: '1' }), one)).toBeUndefined()
  })

  it('sends everything to onboarding when there are no projects', () => {
    expect(onboardingRedirect(at('/'), [])).toBe('/setup')
    expect(onboardingRedirect(at('/home'), [])).toBe('/setup')
    expect(onboardingRedirect(at('/projects/gone'), [])).toBe('/setup')
  })

  it('lets every onboarding step through when there are no projects', () => {
    for (const step of ['you', 'repo', 'agents', 'names']) {
      expect(onboardingRedirect(at('/setup', { step }), [])).toBeUndefined()
    }
    expect(onboardingRedirect(at('/setup'), [])).toBeUndefined()
  })

  it('leaves other pages alone once the server has a project', () => {
    expect(onboardingRedirect(at('/home'), one)).toBeUndefined()
    expect(onboardingRedirect(at('/projects/test-app/board'), one)).toBeUndefined()
    expect(onboardingRedirect(at('/setupx'), one)).toBeUndefined()
  })

  it('decides nothing when the server could not be asked', () => {
    expect(onboardingRedirect(at('/'), null)).toBeUndefined()
    expect(onboardingRedirect(at('/setup'), null)).toBeUndefined()
  })
})
