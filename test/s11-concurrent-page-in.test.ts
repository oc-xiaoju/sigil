import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'

describe('S11: 并发换入去重', () => {
  let mockKv: KVNamespace
  let mockCf: ReturnType<typeof createMockCfApi>
  let pool: WorkerPool
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockCf = createMockCfApi({
      invokeResponse: () => new Response('pong', { status: 200 }),
    })
    pool = new WorkerPool(mockKv, mockCf.cfApi)
    kv = new KvStore(mockKv)

    // Simulate evicted capability: code in KV but not deployed
    await kv.setCode('xiaoju--ping', "export default { fetch() { return new Response('pong') } }")
    await kv.setMeta('xiaoju--ping', {
      type: 'normal',
      created_at: Date.now() - 10000,
      agent: 'xiaoju',
      name: 'ping',
    })
    await kv.setLru('xiaoju--ping', {
      last_access: Date.now() - 10000,
      access_count: 0,
      deployed: false,
    })
  })

  it('should call deployWorker only once for concurrent page-ins', async () => {
    const req1 = new Request('https://sigil.shazhou.workers.dev/xiaoju/ping')
    const req2 = new Request('https://sigil.shazhou.workers.dev/xiaoju/ping')

    // Fire concurrently
    const [resp1, resp2] = await Promise.all([
      pool.invoke('xiaoju--ping', req1),
      pool.invoke('xiaoju--ping', req2),
    ])

    expect(resp1.status).toBe(200)
    expect(resp2.status).toBe(200)

    // Should only deploy once
    const deployCalls = mockCf.deployCalls()
    expect(deployCalls.filter(n => n === 's-xiaoju-ping')).toHaveLength(1)
  })
})
