import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S1: 部署能力', () => {
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

    // Set unified deploy token
    await auth.setToken('deploy-token')
  })

  it('should deploy a capability via API', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: {
        name: 'ping',
        code: "export default { fetch() { return new Response('pong') } }",
        type: 'normal',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(201)

    const body = await resp.json() as {
      capability: string
      url: string
      cold_start: boolean
    }
    expect(body.capability).toBe('ping')
    expect(body.url).toBe('https://sigil.shazhou.workers.dev/run/ping')
    expect(body.cold_start).toBe(false)
  })

  it('should call CfApi.deployWorker', async () => {
    await pool.deploy({
      name: 'ping',
      code: "export default { fetch() { return new Response('pong') } }",
      type: 'normal',
    })

    expect(mockCf.deployCalls()).toContain('s-ping')
  })

  it('should write KV entries (code, meta, lru, route)', async () => {
    await pool.deploy({
      name: 'ping',
      code: "export default { fetch() { return new Response('pong') } }",
      type: 'normal',
    })

    const code = await kv.getCode('ping')
    expect(code).toBeTruthy()

    const meta = await kv.getMeta('ping')
    expect(meta?.type).toBe('normal')

    const lru = await kv.getLru('ping')
    expect(lru?.deployed).toBe(true)
    expect(lru?.access_count).toBe(0)

    const route = await kv.getRoute('ping')
    expect(route?.worker_name).toBe('s-ping')
  })
})
