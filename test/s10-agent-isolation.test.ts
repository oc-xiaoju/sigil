import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S10: Agent 只能操作自己的前缀', () => {
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

    await auth.registerAgent('xiaoju', 'token-xiaoju')
    await auth.registerAgent('xiaomooo', 'token-xiaomooo')
  })

  it('should return 403 when xiaoju tries to deploy as xiaomooo', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'token-xiaoju',  // xiaoju's token
      body: {
        agent: 'xiaomooo',  // but claiming xiaomooo
        name: 'ping',
        code: '// ping',
        type: 'normal',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(403)
  })

  it('should return 403 error message', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'token-xiaoju',
      body: {
        agent: 'xiaomooo',
        name: 'ping',
        code: '// ping',
        type: 'normal',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const body = await resp.json() as { error: string }
    expect(body.error).toContain('xiaoju')
  })

  it('should allow xiaoju to deploy their own capability', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'token-xiaoju',
      body: {
        agent: 'xiaoju',
        name: 'ping',
        code: '// ping',
        type: 'normal',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(201)
  })

  it('should return 403 when removing another agent capability', async () => {
    // First deploy xiaomooo's capability legitimately
    await pool.deploy({
      agent: 'xiaomooo',
      name: 'hello',
      code: '// hello',
      type: 'normal',
    })

    // xiaoju tries to remove it
    const req = makeRequest('DELETE', '/_api/remove', {
      token: 'token-xiaoju',
      body: { capability: 'xiaomooo--hello' },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(403)
  })
})
