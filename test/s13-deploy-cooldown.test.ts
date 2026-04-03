import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'
import { CONFIG } from '../src/config.js'

describe('S13: deploy_cooldown', () => {
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
  })

  it('should reject rapid second deploy with 429', async () => {
    const r1 = await handleRequest(makeRequest('POST', '/_api/deploy', { token: 'deploy-token', body: { name: 'ping', code: '// ping', type: 'normal' } }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(r1.status).toBe(201)
    const r2 = await handleRequest(makeRequest('POST', '/_api/deploy', { token: 'deploy-token', body: { name: 'ping2', code: '// ping2', type: 'normal' } }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(r2.status).toBe(429)
  })

  it('should include retry_after in 429', async () => {
    await handleRequest(makeRequest('POST', '/_api/deploy', { token: 'deploy-token', body: { name: 'ping', code: '// ping', type: 'normal' } }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const r2 = await handleRequest(makeRequest('POST', '/_api/deploy', { token: 'deploy-token', body: { name: 'ping2', code: '// ping2', type: 'normal' } }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const body = await r2.json() as any
    expect(body.retry_after).toBeGreaterThan(0)
    expect(body.retry_after).toBeLessThanOrEqual(5)
  })

  it('should allow deploy after cooldown expires', async () => {
    await kv.setLastDeployTime(Date.now() - 10000)
    const resp = await handleRequest(makeRequest('POST', '/_api/deploy', { token: 'deploy-token', body: { name: 'ping', code: '// ping', type: 'normal' } }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(201)
  })
})
