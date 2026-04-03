import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'
import { CONFIG } from '../src/config.js'

describe('S4: 配额满时换出（LRU）', () => {
  let mockKv: KVNamespace
  let mockCf: ReturnType<typeof createMockCfApi>
  let pool: WorkerPool
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockCf = createMockCfApi({ invokeResponse: () => new Response('ok', { status: 200 }) })
    pool = new WorkerPool(mockKv, mockCf.cfApi, new MockEmbeddingService() as any)
    kv = new KvStore(mockKv)
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) await kv.setSlot(i, { capability: null, status: 'free' })
  })

  async function fillSlots(): Promise<void> {
    const base = Date.now() - 100000
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) {
      const cap = 'cap' + i
      await kv.setCode(cap, '// c' + i)
      await kv.setMeta(cap, { type: 'normal', created_at: base + i * 100 })
      await kv.setLru(cap, { last_access: base + i * 100, access_count: i, deployed: true })
      await kv.setSlot(i, { capability: cap, status: 'active' })
      await kv.setRoute(cap, { slot: i })
    }
  }

  it('should evict coldest when slots full', async () => {
    await fillSlots()
    const result = await pool.deploy({ name: 'new-cap', code: '// new', type: 'normal' })
    expect(result.capability).toBe('new-cap')
    expect(result.evicted).toBe('cap0')
    expect((await kv.getLru('cap0'))?.deployed).toBe(false)
  })

  it('should call updateSlotCode with IDLE code on eviction', async () => {
    await fillSlots(); mockCf.reset()
    await pool.deploy({ name: 'new-cap', code: '// new', type: 'normal' })
    const updates = mockCf.updateSlotCodeCalls()
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates.find(u => u.code.includes('Slot not assigned'))).toBeDefined()
  })

  it('should release slot route after eviction', async () => {
    await fillSlots()
    await pool.deploy({ name: 'new-cap', code: '// new', type: 'normal' })
    expect(await kv.getRoute('cap0')).toBeNull()
  })

  it('should increment eviction count', async () => {
    await fillSlots()
    await pool.deploy({ name: 'new-cap', code: '// new', type: 'normal' })
    expect(await kv.getEvictionCount()).toBe(1)
  })

  it('should prefer evicting expired ephemeral over normal', async () => {
    const base = Date.now() - 100000
    for (let i = 0; i < CONFIG.MAX_SLOTS - 1; i++) {
      const cap = 'normal' + i
      await kv.setCode(cap, '// c' + i)
      await kv.setMeta(cap, { type: 'normal', created_at: base + i * 100 })
      await kv.setLru(cap, { last_access: base + i * 100, access_count: 10, deployed: true })
      await kv.setSlot(i, { capability: cap, status: 'active' })
      await kv.setRoute(cap, { slot: i })
    }
    const last = CONFIG.MAX_SLOTS - 1
    await kv.setCode('ephemeral-old', '// e')
    await kv.setMeta('ephemeral-old', { type: 'ephemeral', ttl: 1, created_at: Date.now() - 10000 })
    await kv.setLru('ephemeral-old', { last_access: Date.now() - 100, access_count: 100, deployed: true })
    await kv.setSlot(last, { capability: 'ephemeral-old', status: 'active' })
    await kv.setRoute('ephemeral-old', { slot: last })
    const result = await pool.deploy({ name: 'newcomer', code: '// new', type: 'normal' })
    expect(result.evicted).toBe('ephemeral-old')
    expect((await kv.getLru('ephemeral-old'))?.deployed).toBe(false)
  })
})
