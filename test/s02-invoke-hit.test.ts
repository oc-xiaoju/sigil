import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'
import { CONFIG } from '../src/config.js'

describe('S2: 调用已部署能力（命中）', () => {
  let mockKv: KVNamespace
  let mockCf: ReturnType<typeof createMockCfApi>
  let pool: WorkerPool
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockCf = createMockCfApi({ invokeResponse: () => new Response('pong', { status: 200 }) })
    pool = new WorkerPool(mockKv, mockCf.cfApi, new MockEmbeddingService() as any)
    kv = new KvStore(mockKv)
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) await kv.setSlot(i, { capability: null, status: 'free' })
    await pool.deploy({ name: 'ping', code: "export default { fetch() { return new Response('pong') } }", type: 'normal' })
    mockCf.reset()
  })

  it('should invoke warm capability', async () => {
    const resp = await pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping'))
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('pong')
  })

  it('should call cfApi.invoke with correct slot index', async () => {
    const route = await kv.getRoute('ping')
    await pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping'))
    expect(mockCf.invokeCalls()).toContain(route!.slot)
  })

  it('should update lru on warm hit', async () => {
    const lruBefore = await kv.getLru('ping')
    await new Promise(r => setTimeout(r, 5))
    await pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping'))
    const lruAfter = await kv.getLru('ping')
    expect(lruAfter!.last_access).toBeGreaterThan(lruBefore!.last_access)
    expect(lruAfter!.access_count).toBe(1)
  })
})
