import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'
import { CONFIG } from '../src/config.js'

describe('S4: 配额满时换出', () => {
  let mockKv: KVNamespace
  let mockCf: ReturnType<typeof createMockCfApi>
  let pool: WorkerPool
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockCf = createMockCfApi({
      invokeResponse: () => new Response('ok', { status: 200 }),
    })
    pool = new WorkerPool(mockKv, mockCf.cfApi)
    kv = new KvStore(mockKv)
  })

  it('should evict the coldest capability when slots are full', async () => {
    const baseTime = Date.now() - 100000

    // Fill up all slots (MAX_SLOTS = 3)
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) {
      const cap = `cap${i}`
      await kv.setCode(cap, `// code ${i}`)
      await kv.setMeta(cap, {
        type: 'normal',
        created_at: baseTime + i * 100,
      })
      await kv.setLru(cap, {
        last_access: baseTime + i * 100,  // cap0 is coldest
        access_count: i,
        deployed: true,
      })
      await kv.setRoute(cap, {
        worker_name: `s-${cap}`,
        subdomain: `s-${cap}.shazhou.workers.dev`,
      })
    }

    // Deploy one more — should trigger eviction of cap0 (oldest last_access)
    const result = await pool.deploy({
      name: 'new-cap',
      code: '// new',
      type: 'normal',
    })

    expect(result.capability).toBe('new-cap')
    expect(result.evicted).toBe('cap0')

    // cap0 should have been deleted
    expect(mockCf.deleteCalls()).toContain('s-cap0')

    // cap0 lru should be deployed=false
    const evictedLru = await kv.getLru('cap0')
    expect(evictedLru?.deployed).toBe(false)
  })

  it('should increment eviction count', async () => {
    const baseTime = Date.now() - 100000

    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) {
      const cap = `cap${i}`
      await kv.setCode(cap, `// code ${i}`)
      await kv.setMeta(cap, {
        type: 'normal',
        created_at: baseTime + i * 100,
      })
      await kv.setLru(cap, {
        last_access: baseTime + i * 100,
        access_count: i,
        deployed: true,
      })
      await kv.setRoute(cap, {
        worker_name: `s-${cap}`,
        subdomain: `s-${cap}.shazhou.workers.dev`,
      })
    }

    await pool.deploy({
      name: 'new-cap',
      code: '// new',
      type: 'normal',
    })

    const evictionCount = await kv.getEvictionCount()
    expect(evictionCount).toBe(1)
  })

  it('should prefer evicting ephemeral_expired over normal', async () => {
    const baseTime = Date.now() - 100000
    const expiredEphemeralCreated = Date.now() - 10000

    // Fill (MAX_SLOTS - 1) normal caps
    for (let i = 0; i < CONFIG.MAX_SLOTS - 1; i++) {
      const cap = `normal${i}`
      await kv.setCode(cap, `// code ${i}`)
      await kv.setMeta(cap, {
        type: 'normal',
        created_at: baseTime + i * 100,
      })
      await kv.setLru(cap, {
        last_access: baseTime + i * 100,
        access_count: 10, // high access
        deployed: true,
      })
      await kv.setRoute(cap, {
        worker_name: `s-${cap}`,
        subdomain: `s-${cap}.shazhou.workers.dev`,
      })
    }

    // Add 1 expired ephemeral (more recently accessed but expired)
    await kv.setCode('ephemeral-old', '// ephemeral')
    await kv.setMeta('ephemeral-old', {
      type: 'ephemeral',
      ttl: 1,  // 1 second TTL, already expired
      created_at: expiredEphemeralCreated,
    })
    await kv.setLru('ephemeral-old', {
      last_access: Date.now() - 100, // recently accessed
      access_count: 100,
      deployed: true,
    })
    await kv.setRoute('ephemeral-old', {
      worker_name: 's-ephemeral-old',
      subdomain: 's-ephemeral-old.shazhou.workers.dev',
    })

    // Deploy one more
    const result = await pool.deploy({
      name: 'newcomer',
      code: '// new',
      type: 'normal',
    })

    // Should evict the expired ephemeral, not the coldest normal
    expect(result.evicted).toBe('ephemeral-old')
    expect(mockCf.deleteCalls()).toContain('s-ephemeral-old')
  })
})
