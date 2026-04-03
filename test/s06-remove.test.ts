import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S6: 删除能力', () => {
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
    pool = new WorkerPool(mockKv, mockLoader.cfApi, mockEmbed as any)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)

    await auth.setToken('deploy-token')

    // Deploy first
    await pool.deploy({
      name: 'ping',
      code: "export default { fetch() { return new Response('pong') } }",
      type: 'normal',
    })
    mockLoader.reset()
  })

  it('should NOT call CF API deleteWorker (Dynamic Workers; KV cleanup only)', async () => {
    const req = makeRequest('DELETE', '/_api/remove', {
      token: 'deploy-token',
      body: { capability: 'ping' },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(200)
    // LOADER should not be called during remove
    expect(mockLoader.loaderCalls()).toHaveLength(0)
  })

  it('should clear all KV entries', async () => {
    await pool.remove('ping')

    expect(await kv.getCode('ping')).toBeNull()
    expect(await kv.getMeta('ping')).toBeNull()
    expect(await kv.getLru('ping')).toBeNull()
    expect(await kv.getRoute('ping')).toBeNull()
  })

  it('should return removed capability in response', async () => {
    const req = makeRequest('DELETE', '/_api/remove', {
      token: 'deploy-token',
      body: { capability: 'ping' },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const body = await resp.json() as { removed: string }
    expect(body.removed).toBe('ping')
  })
})
