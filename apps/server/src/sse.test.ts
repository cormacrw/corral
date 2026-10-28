import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

describe('GET /api/events', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp('pglite')
  })

  afterAll(async () => {
    await t?.close()
  })

  it('streams task changes to subscribers', async () => {
    const project = await t.createProject()
    const res = await t.request('GET', '/api/events')
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let received = ''
    const readUntil = async (text: string) => {
      while (!received.includes(text)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended before "${text}"`)
        received += value
      }
    }

    await readUntil('event: ready')
    await t.createTask(project.slug, { title: 'Streamed' })
    await readUntil('event: task.created')
    await reader.cancel()

    const data = received.split('event: task.created\n')[1]!.split('\n')[0]!.replace(/^data: /, '')
    expect(JSON.parse(data)).toMatchObject({ type: 'task.created', task: { title: 'Streamed', status: 'backlog' } })
  })
})
