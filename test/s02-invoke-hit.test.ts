import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'

describe('S2: 调用已部署能力（命中）', () => {
  let mockKv: KVNamespace
  let mockLoader: ReturnType<typeof createMockLoader>
  let mockEmbed: MockEmbeddingService
  let pool: WorkerPool
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockLoader = createMockLoader({
      invokeResponse: (_workerName, _req) => new Response('pong', { status: 200 }),
    })
    mockEmbed = new MockEmbeddingService()
    pool = new WorkerPool(mockKv, mockLoader.cfApi, mockEmbed as any)
    kv = new KvStore(mockKv)

    // Deploy first
    await pool.deploy({
      name: 'ping',
      code: "export default { fetch() { return new Response('pong') } }",
      type: 'normal',
    })
    mockLoader.reset()
  })

  it('should invoke warm capability', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/ping')
    const resp = await pool.invoke('ping', req)
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('pong')
  })

  it('should update lru.last_access on warm hit', async () => {
    const lruBefore = await kv.getLru('ping')
    const accessBefore = lruBefore!.last_access

    await new Promise(r => setTimeout(r, 5))

    const req = new Request('https://sigil.shazhou.workers.dev/run/ping')
    await pool.invoke('ping', req)

    const lruAfter = await kv.getLru('ping')
    expect(lruAfter!.last_access).toBeGreaterThan(accessBefore)
    expect(lruAfter!.access_count).toBe(1)
  })

  it('should NOT call deployWorker on warm hit', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/ping')
    await pool.invoke('ping', req)
    // LOADER.get() should be called for invoke, but no CF API deploy
    expect(mockLoader.loaderCalls()).toContain('s-ping')
  })
})
