import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S7: 列出能力（已迁移至 query 接口）', () => {
  let mockKv: KVNamespace
  let mockLoader: ReturnType<typeof createMockLoader>
  let mockEmbed: MockEmbeddingService
  let pool: WorkerPool
  let auth: AuthModule
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockLoader = createMockLoader()
    mockEmbed = new MockEmbeddingService()
    pool = new WorkerPool(mockKv, mockLoader.loader, mockEmbed as any)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)

    await auth.setToken('deploy-token')

    // Deploy some capabilities (keep <= MAX_SLOTS=3 to avoid eviction)
    for (const name of ['ping', 'echo', 'hello']) {
      await pool.deploy({
        name,
        code: `// ${name}`,
        type: 'normal',
      })
    }
  })

  it('/_api/list should return 404 (removed)', async () => {
    const req = makeRequest('GET', '/_api/list', {
      token: 'deploy-token',
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(404)
  })

  it('/_api/query should return all capabilities (explore mode)', async () => {
    const req = makeRequest('GET', '/_api/query')

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(200)

    const body = await resp.json() as { total: number; items: Array<{ capability: string }> }
    expect(body.total).toBe(3)
    expect(body.items).toHaveLength(3)

    const names = body.items.map((c: { capability: string }) => c.capability)
    expect(names).toContain('ping')
    expect(names).toContain('echo')
    expect(names).toContain('hello')
  })

  it('should include capability metadata in query results', async () => {
    const result = await pool.query({})
    expect(result.total).toBe(3)
    for (const item of result.items) {
      expect(item.type).toBe('normal')
      expect(item.score).toBeGreaterThan(0)
    }
  })
})
