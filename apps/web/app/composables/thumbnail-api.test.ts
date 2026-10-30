// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { api } from './useApi'

afterEach(() => vi.unstubAllGlobals())

it('sends a multipart file without overriding the browser boundary and returns the project', async () => {
  const project = { slug: 'test-app', thumbnailUrl: '/api/projects/test-app/thumbnail?v=123' }
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(project), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const file = new File(['png bytes'], 'image.png', { type: 'image/png' })
  await expect(api.projects.setThumbnail('test-app', file)).resolves.toEqual(project)
  const [path, options] = fetch.mock.calls[0]!
  expect(path).toBe('/api/projects/test-app/thumbnail')
  expect(options.method).toBe('PUT')
  expect(options.headers).toEqual({})
  expect(options.body).toBeInstanceOf(FormData)
  expect(options.body.get('file')).toBe(file)
  await expect(api.projects.clearThumbnail('test-app')).resolves.toEqual(project)
  expect(fetch.mock.calls[1]).toEqual(['/api/projects/test-app/thumbnail', expect.objectContaining({ method: 'DELETE', body: undefined })])
})
