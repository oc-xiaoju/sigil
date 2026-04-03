import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'
import { CONFIG } from '../src/config.js'

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
    await auth.setToken('deploy-token')
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) {
      await kv.setSlot(i, { capability: null, status: 'free' })
    }
  })

  it('should deploy via API', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: { name: 'ping', code: "export default { fetch() { return new Response('pong') } }", type: 'normal' },
    })
    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(201)
    const body = await resp.json() as { capability: string; url: string; cold_start: boolean }
    expect(body.capability).toBe('ping')
    expect(body.url).toBe('https://sigil.shazhou.workers.dev/run/ping')
    expect(body.cold_start).toBe(false)
  })

  it('should call updateSlotCode on deploy', async () => {
    await pool.deploy({ name: 'ping', code: "export default { fetch() { return new Response('pong') } }", type: 'normal' })
    const updates = mockCf.updateSlotCodeCalls()
    expect(updates).toHaveLength(1)
    expect(updates[0]!.slotIndex).toBeGreaterThanOrEqual(0)
    expect(updates[0]!.slotIndex).toBeLessThan(CONFIG.MAX_SLOTS)
  })

  it('should NOT call cfApi.invoke during deploy', async () => {
    await pool.deploy({ name: 'ping', code: "export default { fetch() { return new Response('pong') } }", type: 'normal' })
    expect(mockCf.invokeCalls()).toHaveLength(0)
  })

  it('should write KV entries with slot route', async () => {
    await pool.deploy({ name: 'ping', code: "export default { fetch() { return new Response('pong') } }", type: 'normal' })
    expect(await kv.getCode('ping')).toBeTruthy()
    expect((await kv.getMeta('ping'))?.type).toBe('normal')
    const lru = await kv.getLru('ping')
    expect(lru?.deployed).toBe(true)
    expect(lru?.access_count).toBe(0)
    const route = await kv.getRoute('ping')
    expect(route).not.toBeNull()
    expect(typeof route?.slot).toBe('number')
  })

  it('should update slot to active after deploy', async () => {
    await pool.deploy({ name: 'ping', code: "export default { fetch() { return new Response('pong') } }", type: 'normal' })
    const route = await kv.getRoute('ping')
    const slot = await kv.getSlot(route!.slot)
    expect(slot?.status).toBe('active')
    expect(slot?.capability).toBe('ping')
  })

  it('模式 B: schema + execute', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: { name: 'adder', type: 'normal',
        schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a','b'] },
        execute: 'return JSON.stringify({ sum: input.a + input.b })' },
    })
    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(201)
    expect((await resp.json() as any).capability).toBe('adder')
  })

  it('模式 B: 生成 code 含 export default', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: { name: 'greeter', type: 'normal',
        schema: { type: 'object', properties: { name: { type: 'string' } } },
        execute: 'return "Hello, " + input.name + "!"' },
    })
    await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const code = await kv.getCode('greeter')
    expect(code).toContain('export default')
    expect(code).toContain('async fetch(request)')
  })

  it('code + schema 同时 → 400', async () => {
    const req = makeRequest('POST', '/_api/deploy', {
      token: 'deploy-token',
      body: { name: 'bad', type: 'normal',
        code: 'export default{}',
        schema: { type: 'object', properties: {} }, execute: 'return "x"' },
    })
    expect((await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })).status).toBe(400)
  })

  it('无 code 无 execute → 400', async () => {
    const req = makeRequest('POST', '/_api/deploy', { token: 'deploy-token', body: { name: 'bad', type: 'normal' } })
    expect((await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })).status).toBe(400)
  })
})
