import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S1: 部署能力', () => {
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

  it('should NOT call CF API deployWorker (Dynamic Workers only)', async () => {
    await pool.deploy({
      name: 'ping',
      code: "export default { fetch() { return new Response('pong') } }",
      type: 'normal',
    })

    // LOADER.get() should NOT be called during deploy — only during invoke
    expect(mockLoader.loaderCalls()).toHaveLength(0)
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

  // --- 模式 B: schema + execute ---

  it('模式 B: schema + execute 通过 API 部署', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: {
        name: 'adder',
        type: 'normal',
        schema: {
          type: 'object',
          properties: {
            a: { type: 'number', description: 'First number' },
            b: { type: 'number', description: 'Second number' },
          },
          required: ['a', 'b'],
        },
        execute: 'return JSON.stringify({ sum: input.a + input.b })',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(201)

    const body = await resp.json() as { capability: string; url: string }
    expect(body.capability).toBe('adder')
    expect(body.url).toBe('https://sigil.shazhou.workers.dev/run/adder')
  })

  it('模式 B: 生成的 code 存入 KV（包含 export default）', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: {
        name: 'greeter',
        type: 'normal',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', default: 'World' },
          },
        },
        execute: 'return "Hello, " + input.name + "!"',
      },
    })

    await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })

    const code = await kv.getCode('greeter')
    expect(code).toBeTruthy()
    expect(code).toContain('export default')
    expect(code).toContain('async fetch(request)')
  })

  it('模式 B: schema 存入 KV meta', async () => {
    const schema = {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Source currency' },
        to: { type: 'string', description: 'Target currency' },
        amount: { type: 'number', description: 'Amount', default: 1 },
      },
      required: ['from', 'to'],
    }

    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: {
        name: 'currency',
        type: 'persistent',
        description: 'Currency converter',
        tags: ['finance'],
        schema,
        execute: 'return JSON.stringify({ from: input.from, to: input.to, amount: input.amount })',
      },
    })

    await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })

    const meta = await kv.getMeta('currency')
    expect(meta?.schema).toBeDefined()
    expect(meta?.schema?.properties.from.type).toBe('string')
    expect(meta?.schema?.required).toContain('from')
    expect(meta?.schema?.required).toContain('to')
  })

  it('模式 B + A 同时提供 → 400 错误', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: {
        name: 'bad',
        type: 'normal',
        code: 'export default { fetch() { return new Response("hi") } }',
        schema: { properties: {} },
        execute: 'return "hello"',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(400)
    const body = await resp.json() as { error: string }
    expect(body.error).toContain('Cannot specify both code and schema/execute')
  })

  it('code 和 execute 都不提供 → 400 错误', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: {
        name: 'bad',
        type: 'normal',
      },
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(400)
    const body = await resp.json() as { error: string }
    expect(body.error).toContain('Must specify either code or schema+execute')
  })
})
