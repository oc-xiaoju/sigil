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

    // Fill up all slots (MAX_SLOTS = 10)
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) {
      const name = `cap${i}`
      const capability = `xiaoju--${name}`
      await kv.setCode(capability, `// code ${i}`)
      await kv.setMeta(capability, {
        type: 'normal',
        created_at: baseTime + i * 100,
        agent: 'xiaoju',
        name,
      })
      await kv.setLru(capability, {
        last_access: baseTime + i * 100,  // cap0 is coldest
        access_count: i,
        deployed: true,
      })
      await kv.setRoute(capability, {
        worker_name: `s-xiaoju-${name}`,
        subdomain: `s-xiaoju-${name}.shazhou.workers.dev`,
      })
    }

    // Deploy one more — should trigger eviction of cap0 (oldest last_access)
    const result = await pool.deploy({
      agent: 'xiaoju',
      name: 'new-cap',
      code: '// new',
      type: 'normal',
    })

    expect(result.capability).toBe('xiaoju--new-cap')
    expect(result.evicted).toBe('xiaoju--cap0')

    // cap0 should have been deleted
    expect(mockCf.deleteCalls()).toContain('s-xiaoju-cap0')

    // cap0 lru should be deployed=false
    const evictedLru = await kv.getLru('xiaoju--cap0')
    expect(evictedLru?.deployed).toBe(false)
  })

  it('should increment eviction count', async () => {
    const baseTime = Date.now() - 100000

    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) {
      const name = `cap${i}`
      const capability = `xiaoju--${name}`
      await kv.setCode(capability, `// code ${i}`)
      await kv.setMeta(capability, {
        type: 'normal',
        created_at: baseTime + i * 100,
        agent: 'xiaoju',
        name,
      })
      await kv.setLru(capability, {
        last_access: baseTime + i * 100,
        access_count: i,
        deployed: true,
      })
      await kv.setRoute(capability, {
        worker_name: `s-xiaoju-${name}`,
        subdomain: `s-xiaoju-${name}.shazhou.workers.dev`,
      })
    }

    await pool.deploy({
      agent: 'xiaoju',
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

    // Fill 9 normal caps
    for (let i = 0; i < CONFIG.MAX_SLOTS - 1; i++) {
      const name = `normal${i}`
      const capability = `xiaoju--${name}`
      await kv.setCode(capability, `// code ${i}`)
      await kv.setMeta(capability, {
        type: 'normal',
        created_at: baseTime + i * 100,
        agent: 'xiaoju',
        name,
      })
      await kv.setLru(capability, {
        last_access: baseTime + i * 100,
        access_count: 10, // high access
        deployed: true,
      })
      await kv.setRoute(capability, {
        worker_name: `s-xiaoju-${name}`,
        subdomain: `s-xiaoju-${name}.shazhou.workers.dev`,
      })
    }

    // Add 1 expired ephemeral (more recently accessed but expired)
    await kv.setCode('xiaoju--ephemeral-old', '// ephemeral')
    await kv.setMeta('xiaoju--ephemeral-old', {
      type: 'ephemeral',
      ttl: 1,  // 1 second TTL, already expired
      created_at: expiredEphemeralCreated,
      agent: 'xiaoju',
      name: 'ephemeral-old',
    })
    await kv.setLru('xiaoju--ephemeral-old', {
      last_access: Date.now() - 100, // recently accessed
      access_count: 100,
      deployed: true,
    })
    await kv.setRoute('xiaoju--ephemeral-old', {
      worker_name: 's-xiaoju-ephemeral-old',
      subdomain: 's-xiaoju-ephemeral-old.shazhou.workers.dev',
    })

    // Deploy one more
    const result = await pool.deploy({
      agent: 'xiaoju',
      name: 'newcomer',
      code: '// new',
      type: 'normal',
    })

    // Should evict the expired ephemeral, not the coldest normal
    expect(result.evicted).toBe('xiaoju--ephemeral-old')
    expect(mockCf.deleteCalls()).toContain('s-xiaoju-ephemeral-old')
  })
})
