// @vitest-environment happy-dom
import type { Project, ServerEvent } from '@corral/contracts'
import { expect, it } from 'vitest'
import { mockCall, onMockEvent } from './mock-api'

it('keeps multipart thumbnail writes in fixtures and broadcasts upload, colour and removal', async () => {
  const path = '/projects/marketing-site'
  const original = await mockCall<Project>('GET', path)
  const events: ServerEvent[] = []
  const stop = onMockEvent(event => events.push(event))
  try {
    const body = new FormData()
    body.append('file', new File(['image bytes'], 'thumbnail.png', { type: 'image/png' }))
    const uploaded = await mockCall<Project>('PUT', `${path}/thumbnail`, body)
    expect(uploaded.thumbnailUrl).toBe('data:image/png;base64,aW1hZ2UgYnl0ZXM=')
    expect((await mockCall<Project>('GET', path)).thumbnailUrl).toBe(uploaded.thumbnailUrl)
    const recoloured = await mockCall<Project>('PATCH', path, { thumbnailColor: '#ef4444' })
    expect(recoloured.thumbnailUrl).toBe(uploaded.thumbnailUrl)
    expect(recoloured.thumbnailColor).toBe('#ef4444')
    const cleared = await mockCall<Project>('DELETE', `${path}/thumbnail`)
    expect(cleared.thumbnailUrl).toBeNull()
    expect(cleared.thumbnailColor).toBe('#ef4444')
    expect((await mockCall<Project>('GET', path)).thumbnailUrl).toBeNull()
    expect(events.map(event => event.type)).toEqual(['project.updated', 'project.updated', 'project.updated'])
    expect(events[0]).toMatchObject({ project: { thumbnailUrl: uploaded.thumbnailUrl } })
    expect(events[2]).toMatchObject({ project: { thumbnailUrl: null } })
  } finally {
    stop()
    await mockCall('PATCH', path, original)
  }
})
