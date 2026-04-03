import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'

describe('S3: 调用未部署能力（换入）', () => {
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

  it('should page in and call deployWorker', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/ping')
    const resp = await pool.invoke('ping', req)

    expect(resp.status).toBe(200)
    expect(mockCf.deployCalls()).toContain('s-ping')
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

  it('should write route entry after page-in', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/ping')
    await pool.invoke('ping', req)

    const route = await kv.getRoute('ping')
    expect(route?.worker_name).toBe('s-ping')
  })
})
