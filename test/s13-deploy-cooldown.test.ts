import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S13: deploy_cooldown', () => {
  let mockKv: KVNamespace
  let mockCf: ReturnType<typeof createMockCfApi>
  let mockEmbed: MockEmbeddingService
  let pool: WorkerPool
  let auth: AuthModule
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockCf = createMockCfApi()
    mockEmbed = new MockEmbeddingService()
    pool = new WorkerPool(mockKv, mockCf.cfApi, mockEmbed as any)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)

    await auth.setToken('deploy-token')
  })

  it('should reject rapid second deploy with 429', async () => {
    // First deploy
    const req1 = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: {
        name: 'ping',
        code: '// ping',
        type: 'normal',
      },
    })
    const resp1 = await handleRequest(req1, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp1.status).toBe(201)

    // Immediate second deploy (< 5s cooldown)
    const req2 = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: {
        name: 'ping2',
        code: '// ping2',
        type: 'normal',
      },
    })
    const resp2 = await handleRequest(req2, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp2.status).toBe(429)
  })

  it('should include retry_after in 429 response', async () => {
    // First deploy
    const req1 = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: { name: 'ping', code: '// ping', type: 'normal' },
    })
    await handleRequest(req1, { SIGIL_KV: mockKv, backend: pool, auth, kv })

    // Immediate second
    const req2 = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: { name: 'ping2', code: '// ping2', type: 'normal' },
    })
    const resp2 = await handleRequest(req2, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const body = await resp2.json() as { error: string; retry_after: number }

    expect(body.retry_after).toBeGreaterThan(0)
    expect(body.retry_after).toBeLessThanOrEqual(5)
  })

  it('should allow deploy after cooldown expires', async () => {
    // Manually set last deploy time as already expired
    await kv.setLastDeployTime(Date.now() - 10000)  // 10s ago, past 5s cooldown

    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: { name: 'ping', code: '// ping', type: 'normal' },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(201)
  })
})
