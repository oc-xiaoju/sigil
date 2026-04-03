import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S6: 删除能力', () => {
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

    await auth.setToken('deploy-token')

    // Deploy first
    await pool.deploy({
      name: 'ping',
      code: "export default { fetch() { return new Response('pong') } }",
      type: 'normal',
    })
    mockCf.reset()
  })

  it('should call CfApi.deleteWorker', async () => {
    const req = makeRequest('DELETE', '/_api/remove', {
      token: 'deploy-token',
      body: { capability: 'ping' },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(200)
    expect(mockCf.deleteCalls()).toContain('s-ping')
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
