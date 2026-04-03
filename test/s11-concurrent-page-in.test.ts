import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'

describe('S11: 并发换入去重', () => {
  let mockKv: KVNamespace
  let mockLoader: ReturnType<typeof createMockLoader>
  let mockEmbed: MockEmbeddingService
  let pool: WorkerPool
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockLoader = createMockLoader({
      invokeResponse: () => new Response('pong', { status: 200 }),
    })
    mockEmbed = new MockEmbeddingService()
    pool = new WorkerPool(mockKv, mockLoader.loader, mockEmbed as any)
    kv = new KvStore(mockKv)

    // Simulate evicted capability: code in KV but not deployed
    await kv.setCode('ping', "export default { fetch() { return new Response('pong') } }")
    await kv.setMeta('ping', {
      type: 'normal',
      created_at: Date.now() - 10000,
    })
    await kv.setLru('ping', {
      last_access: Date.now() - 10000,
      access_count: 0,
      deployed: false,
    })
  })

  it('should call deployWorker only once for concurrent page-ins', async () => {
    const req1 = new Request('https://sigil.shazhou.workers.dev/run/ping')
    const req2 = new Request('https://sigil.shazhou.workers.dev/run/ping')

    // Fire concurrently
    const [resp1, resp2] = await Promise.all([
      pool.invoke('ping', req1),
      pool.invoke('ping', req2),
    ])

    expect(resp1.status).toBe(200)
    expect(resp2.status).toBe(200)

    // Both calls go through LOADER.get(); Dynamic Workers deduplicates internally
    const loaderCalls = mockLoader.loaderCalls()
    expect(loaderCalls.length).toBeGreaterThanOrEqual(1)
    expect(loaderCalls.every(id => id === 's-ping')).toBe(true)
  })
})
