import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S9: 无 token 拒绝', () => {
  let mockKv: KVNamespace
  let pool: WorkerPool
  let auth: AuthModule
  let kv: KvStore

  beforeEach(() => {
    mockKv = createMockKv()
    const mockCf = createMockCfApi()
    pool = new WorkerPool(mockKv, mockCf.cfApi, new MockEmbeddingService() as any)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)
  })

  it('should return 401 with no token', async () => {
    const resp = await handleRequest(makeRequest('POST', '/_api/deploy', { body: { name: 'ping', code: '// ping', type: 'normal' } }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(401)
  })

  it('should return 401 with wrong token', async () => {
    const resp = await handleRequest(makeRequest('POST', '/_api/deploy', { token: 'wrong', body: { name: 'ping', code: '// ping', type: 'normal' } }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(401)
  })

  it('should return 401 on DELETE without token', async () => {
    const resp = await handleRequest(makeRequest('DELETE', '/_api/remove', { body: { capability: 'ping' } }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(401)
  })

  it('should return error message', async () => {
    const resp = await handleRequest(makeRequest('POST', '/_api/deploy', { body: { name: 'ping', code: '// ping', type: 'normal' } }), { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect((await resp.json() as any).error).toBeTruthy()
  })
})
