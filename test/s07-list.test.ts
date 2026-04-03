import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'
import { CONFIG } from '../src/config.js'

describe('S7: 列出能力', () => {
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
    await auth.setToken('deploy-token')
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) await kv.setSlot(i, { capability: null, status: 'free' })
    for (const name of ['ping', 'echo', 'hello']) {
      await pool.deploy({ name, code: '// ' + name, type: 'normal' })
    }
  })

  it('/_api/list should return 404', async () => {
    const resp = await handleRequest(makeRequest('GET', '/_api/list', { token: 'deploy-token' }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(404)
  })

  it('/_api/query returns all capabilities', async () => {
    const resp = await handleRequest(makeRequest('GET', '/_api/query'), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { total: number; items: Array<{ capability: string }> }
    expect(body.total).toBe(3)
    const names = body.items.map(c => c.capability)
    expect(names).toContain('ping')
    expect(names).toContain('echo')
    expect(names).toContain('hello')
  })

  it('should include capability metadata', async () => {
    const result = await pool.query({})
    expect(result.total).toBe(3)
    for (const item of result.items) expect(item.type).toBe('normal')
  })
})
