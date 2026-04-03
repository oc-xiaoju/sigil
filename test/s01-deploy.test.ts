import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S1: 部署能力', () => {
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

    // Register agent
    await auth.registerAgent('xiaoju', 'token-xiaoju')
  })

  it('should deploy a capability via API', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'token-xiaoju',
      body: {
        agent: 'xiaoju',
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
    expect(body.capability).toBe('xiaoju--ping')
    expect(body.url).toBe('https://sigil.shazhou.workers.dev/xiaoju/ping')
    expect(body.cold_start).toBe(false)
  })

  it('should call CfApi.deployWorker', async () => {
    await pool.deploy({
      agent: 'xiaoju',
      name: 'ping',
      code: "export default { fetch() { return new Response('pong') } }",
      type: 'normal',
    })

    expect(mockCf.deployCalls()).toContain('s-xiaoju-ping')
  })

  it('should write KV entries (code, meta, lru, route)', async () => {
    await pool.deploy({
      agent: 'xiaoju',
      name: 'ping',
      code: "export default { fetch() { return new Response('pong') } }",
      type: 'normal',
    })

    const code = await kv.getCode('xiaoju--ping')
    expect(code).toBeTruthy()

    const meta = await kv.getMeta('xiaoju--ping')
    expect(meta?.agent).toBe('xiaoju')
    expect(meta?.name).toBe('ping')
    expect(meta?.type).toBe('normal')

    const lru = await kv.getLru('xiaoju--ping')
    expect(lru?.deployed).toBe(true)
    expect(lru?.access_count).toBe(0)

    const route = await kv.getRoute('xiaoju--ping')
    expect(route?.worker_name).toBe('s-xiaoju-ping')
  })
})
