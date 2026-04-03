import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'

describe('S5: 调用不存在的能力', () => {
  let mockKv: KVNamespace
  let mockLoader: ReturnType<typeof createMockLoader>
  let mockEmbed: MockEmbeddingService
  let pool: WorkerPool

  beforeEach(() => {
    mockKv = createMockKv()
    mockLoader = createMockLoader()
    mockEmbed = new MockEmbeddingService()
    pool = new WorkerPool(mockKv, mockLoader.loader, mockEmbed as any)
  })

  it('should return 404 for nonexistent capability', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/nonexistent')
    const resp = await pool.invoke('nonexistent', req)
    expect(resp.status).toBe(404)
  })

  it('should return error JSON body', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/nonexistent')
    const resp = await pool.invoke('nonexistent', req)
    const body = await resp.json() as { error: string }
    expect(body.error).toBeTruthy()
  })

  it('should not call LOADER.get for nonexistent capability', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/nonexistent')
    await pool.invoke('nonexistent', req)
    expect(mockLoader.loaderCalls()).toHaveLength(0)
  })
})
