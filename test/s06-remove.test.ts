import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'
import { CONFIG } from '../src/config.js'

describe('S6: 删除能力', () => {
  let mockKv: KVNamespace
  let mockCf: ReturnType<typeof createMockCfApi>
  let pool: WorkerPool
  let auth: AuthModule
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockCf = createMockCfApi()
    pool = new WorkerPool(mockKv, mockCf.cfApi, new MockEmbeddingService() as any)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)
    await auth.setToken('deploy-token')
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) await kv.setSlot(i, { capability: null, status: 'free' })
    await pool.deploy({ name: 'ping', code: "export default { fetch() { return new Response('pong') } }", type: 'normal' })
    mockCf.reset()
  })

  it('should call updateSlotCode with IDLE code on remove', async () => {
    const resp = await handleRequest(
      makeRequest('DELETE', '/_api/remove', { token: 'deploy-token', body: { capability: 'ping' } }),
      { SIGIL_KV: mockKv, backend: pool, auth, kv },
    )
    expect(resp.status).toBe(200)
    const updates = mockCf.updateSlotCodeCalls()
    expect(updates.length).toBe(1)
    expect(updates[0]!.code).toContain('Slot not assigned')
  })

  it('should free slot after remove', async () => {
    const route = await kv.getRoute('ping')
    await pool.remove('ping')
    const slot = await kv.getSlot(route!.slot)
    expect(slot?.status).toBe('free')
    expect(slot?.capability).toBeNull()
  })

  it('should clear all KV entries', async () => {
    await pool.remove('ping')
    expect(await kv.getCode('ping')).toBeNull()
    expect(await kv.getMeta('ping')).toBeNull()
    expect(await kv.getLru('ping')).toBeNull()
    expect(await kv.getRoute('ping')).toBeNull()
  })

  it('should return removed capability', async () => {
    const resp = await handleRequest(
      makeRequest('DELETE', '/_api/remove', { token: 'deploy-token', body: { capability: 'ping' } }),
      { SIGIL_KV: mockKv, backend: pool, auth, kv },
    )
    expect((await resp.json() as any).removed).toBe('ping')
  })
})
