import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'
import { CONFIG } from '../src/config.js'

describe('S8: 健康端点', () => {
  let mockKv: KVNamespace
  let pool: WorkerPool
  let auth: AuthModule
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    const mockCf = createMockCfApi()
    pool = new WorkerPool(mockKv, mockCf.cfApi, new MockEmbeddingService() as any)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) await kv.setSlot(i, { capability: null, status: 'free' })
    await pool.deploy({ name: 'ping', code: '// ping', type: 'normal' })
  })

  it('should return 200 on GET /_health', async () => {
    const resp = await handleRequest(makeRequest('GET', '/_health'), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(200)
  })

  it('should return backend status', async () => {
    const resp = await handleRequest(makeRequest('GET', '/_health'), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const body = await resp.json() as any
    expect(body.backend).toBe('worker-pool')
    expect(body.total_slots).toBeGreaterThan(0)
    expect(body.used_slots).toBe(1)
    expect(body.lru_enabled).toBe(true)
    expect(typeof body.eviction_count).toBe('number')
  })
})
