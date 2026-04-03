import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S9: 无 token 拒绝', () => {
  let mockKv: KVNamespace
  let mockLoader: ReturnType<typeof createMockLoader>
  let mockEmbed: MockEmbeddingService
  let pool: WorkerPool
  let auth: AuthModule
  let kv: KvStore

  beforeEach(() => {
    mockKv = createMockKv()
    mockLoader = createMockLoader()
    mockEmbed = new MockEmbeddingService()
    pool = new WorkerPool(mockKv, mockLoader.loader, mockEmbed as any)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)
  })

  it('should return 401 when no Authorization header', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      // No token
      body: {
        name: 'ping',
        code: '// ping',
        type: 'normal',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(401)
  })

  it('should return 401 when wrong token', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'wrong-token',
      body: {
        name: 'ping',
        code: '// ping',
        type: 'normal',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(401)
  })

  it('should return 401 on DELETE without token', async () => {
    const req = makeRequest('DELETE', '/_api/remove', {
      body: { capability: 'ping' },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(401)
  })

  it('should return error message in body', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      body: {
        name: 'ping',
        code: '// ping',
        type: 'normal',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const body = await resp.json() as { error: string }
    expect(body.error).toBeTruthy()
  })
})
