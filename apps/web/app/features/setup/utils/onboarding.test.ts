import { describe, expect, it } from 'vitest'
import { onboardingRedirect, repoBlockedReason, repoFromUrl } from '~/features/setup/utils/onboarding.ts'

const one = [{ slug: 'test-app' }]
const at = (path: string, query: Record<string, string> = {}) => ({ path, query })

describe('onboardingRedirect', () => {
  it('opens Home once onboarding is complete', () => {
    expect(onboardingRedirect(at('/'), one)).toBe('/home')
    expect(onboardingRedirect(at('/'), [{ slug: 'a' }, { slug: 'b' }])).toBe('/home')
    expect(onboardingRedirect(at('/setup/you'), one)).toBe('/home')
    expect(onboardingRedirect(at('/setup', { add: '1' }), one)).toBeUndefined()
    expect(onboardingRedirect(at('/'), [])).toBe('/setup')
    expect(onboardingRedirect(at('/'), null)).toBeUndefined()
  })

  it('sends the wizard to Home once the server has a project', () => {
    expect(onboardingRedirect(at('/setup'), one)).toBe('/home')
    expect(onboardingRedirect(at('/setup', { step: 'you' }), one)).toBe('/home')
    expect(onboardingRedirect(at('/setup', { step: 'repo' }), one)).toBe('/home')
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

describe('pasted and blocked repositories', () => {
  it.each(['https://github.com/owner/name', 'http://github.com/owner/name/', 'https://github.com/owner/name.git', 'owner/name'])('reduces %s to owner/name', (url) => {
    expect(repoFromUrl(url)).toBe('owner/name')
  })

  it('says why a repository cannot be picked', () => {
    expect(repoBlockedReason({ reason: null, usedBy: null })).toBeNull()
    expect(repoBlockedReason({ reason: 'read_only', usedBy: null })).toContain('Read-only access')
    expect(repoBlockedReason({ reason: 'used', usedBy: { name: 'Corral' } } as never)).toBe('Used by Corral')
  })
})
