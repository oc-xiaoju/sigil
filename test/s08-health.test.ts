import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S8: 健康端点', () => {
  let mockKv: KVNamespace
  let mockCf: ReturnType<typeof createMockCfApi>
  let pool: WorkerPool
  let auth: AuthModule
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockCf = createMockCfApi()
    pool = new WorkerPool(mockKv, mockCf.cfApi)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)

    // Deploy some capabilities
    await pool.deploy({
      name: 'ping',
      code: '// ping',
      type: 'normal',
    })
  })

  it('should return 200 on GET /_health', async () => {
    const req = makeRequest('GET', '/_health')
    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(200)
  })

  it('should return backend status fields', async () => {
    const req = makeRequest('GET', '/_health')
    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const body = await resp.json() as {
      backend: string
      total_slots: number
      used_slots: number
      lru_enabled: boolean
      eviction_count: number
    }

    expect(body.backend).toBe('worker-pool')
    expect(typeof body.total_slots).toBe('number')
    expect(body.total_slots).toBeGreaterThan(0)
    expect(typeof body.used_slots).toBe('number')
    expect(body.used_slots).toBe(1)
    expect(body.lru_enabled).toBe(true)
    expect(typeof body.eviction_count).toBe('number')
  })
})
