import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'
import { CONFIG } from '../src/config.js'

describe('S3: 调用未部署能力（冷启动）', () => {
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
    await kv.setCode('ping', "export default { fetch() { return new Response('pong') } }")
    await kv.setMeta('ping', { type: 'normal', created_at: Date.now() - 10000 })
    await kv.setLru('ping', { last_access: Date.now() - 10000, access_count: 5, deployed: false })
  })

  it('should page-in and call updateSlotCode', async () => {
    const resp = await pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping'))
    expect(resp.status).toBe(200)
    expect(mockCf.updateSlotCodeCalls()).toHaveLength(1)
  })

  it('should set lru.deployed=true after page-in', async () => {
    await pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping'))
    expect((await kv.getLru('ping'))?.deployed).toBe(true)
  })

  it('should set X-Sigil-Cold-Start header', async () => {
    const resp = await pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping'))
    expect(resp.headers.get('X-Sigil-Cold-Start')).toBe('true')
  })

  it('should write route entry after page-in', async () => {
    await pool.invoke('ping', new Request('https://sigil.shazhou.workers.dev/run/ping'))
    const route = await kv.getRoute('ping')
    expect(route).not.toBeNull()
    expect(typeof route?.slot).toBe('number')
  })
})
