import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'
import { CONFIG } from '../src/config.js'

describe('S11: 并发换入', () => {
  let mockKv: KVNamespace
  let pool: WorkerPool
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    const mockCf = createMockCfApi({ invokeResponse: () => new Response('pong', { status: 200 }) })
    pool = new WorkerPool(mockKv, mockCf.cfApi, new MockEmbeddingService() as any)
    kv = new KvStore(mockKv)
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) await kv.setSlot(i, { capability: null, status: 'free' })
    await kv.setCode('ping', "export default { fetch() { return new Response('pong') } }")
    await kv.setMeta('ping', { type: 'normal', created_at: Date.now() - 10000 })
    await kv.setLru('ping', { last_access: Date.now() - 10000, access_count: 0, deployed: false })
  })

  it('should handle concurrent page-ins without error', async () => {
    const [r1, r2] = await Promise.all([
      pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping')),
      pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping')),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
  })

  it('should have route after concurrent page-in', async () => {
    await Promise.all([
      pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping')),
      pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping')),
    ])
    const route = await kv.getRoute('ping')
    expect(route).not.toBeNull()
    expect(typeof route?.slot).toBe('number')
  })
})
