import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'

describe('S3: 调用未部署能力（换入）', () => {
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

    // Manually write KV to simulate "evicted but not deleted from KV" state
    await kv.setCode('ping', "export default { fetch() { return new Response('pong') } }")
    await kv.setMeta('ping', {
      type: 'normal',
      created_at: Date.now() - 10000,
    })
    await kv.setLru('ping', {
      last_access: Date.now() - 10000,
      access_count: 5,
      deployed: false, // key: not deployed
    })
  })

  it('should page in and call LOADER.get', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/ping')
    const resp = await pool.invoke('ping', req)

    expect(resp.status).toBe(200)
    // LOADER.get() should be called (Dynamic Workers executes inline)
    expect(mockLoader.loaderCalls().length).toBeGreaterThan(0)
  })

  it('should set lru.deployed=true after page-in', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/ping')
    await pool.invoke('ping', req)

    const lru = await kv.getLru('ping')
    expect(lru?.deployed).toBe(true)
  })

  it('should set X-Sigil-Cold-Start header', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/ping')
    const resp = await pool.invoke('ping', req)

    expect(resp.headers.get('X-Sigil-Cold-Start')).toBe('true')
  })

  it('should NOT set X-Sigil-Cold-Start on warm hit', async () => {
    // First invoke (cold)
    const req1 = new Request('https://sigil.shazhou.workers.dev/run/ping')
    await pool.invoke('ping', req1)

    // Second invoke (warm)
    const req2 = new Request('https://sigil.shazhou.workers.dev/run/ping')
    const resp2 = await pool.invoke('ping', req2)

    expect(resp2.headers.get('X-Sigil-Cold-Start')).toBeNull()
  })
})
