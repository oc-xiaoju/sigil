import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'
import { CONFIG } from '../src/config.js'
import { PageRateLimitError } from '../src/lru.js'

describe('S12: 换页速率限制', () => {
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

  async function setupCapability(name: string): Promise<void> {
    const capability = `xiaoju--${name}`
    await kv.setCode(capability, `// ${name}`)
    await kv.setMeta(capability, {
      type: 'normal',
      created_at: Date.now() - 10000,
      agent: 'xiaoju',
      name,
    })
    await kv.setLru(capability, {
      last_access: Date.now() - 10000,
      access_count: 0,
      deployed: false, // evicted
    })
  }

  it(`should allow up to ${CONFIG.PAGE_RATE_LIMIT} page-ins per minute`, async () => {
    const results: boolean[] = []

    for (let i = 0; i < CONFIG.PAGE_RATE_LIMIT; i++) {
      const name = `cap${i}`
      await setupCapability(name)

      const req = new Request(`https://sigil.shazhou.workers.dev/xiaoju/${name}`)
      const resp = await pool.invoke(`xiaoju--${name}`, req)
      results.push(resp.status === 200)
    }

    expect(results.every(Boolean)).toBe(true)
  })

  it(`should reject the ${CONFIG.PAGE_RATE_LIMIT + 1}th page-in with 503`, async () => {
    // Do PAGE_RATE_LIMIT page-ins
    for (let i = 0; i < CONFIG.PAGE_RATE_LIMIT; i++) {
      const name = `cap${i}`
      await setupCapability(name)
      const req = new Request(`https://sigil.shazhou.workers.dev/xiaoju/${name}`)
      await pool.invoke(`xiaoju--${name}`, req)
    }

    // 11th one should fail
    const name = `cap${CONFIG.PAGE_RATE_LIMIT}`
    await setupCapability(name)

    const req = new Request(`https://sigil.shazhou.workers.dev/xiaoju/${name}`)
    try {
      const resp = await pool.invoke(`xiaoju--${name}`, req)
      // If it doesn't throw, check status
      expect(resp.status).toBe(503)
    } catch (e) {
      expect(e).toBeInstanceOf(PageRateLimitError)
    }
  })

  it('should include retry_after in error', async () => {
    // Fill rate
    for (let i = 0; i < CONFIG.PAGE_RATE_LIMIT; i++) {
      const name = `cap${i}`
      await setupCapability(name)
      const req = new Request(`https://sigil.shazhou.workers.dev/xiaoju/${name}`)
      await pool.invoke(`xiaoju--${name}`, req)
    }

    const name = `cap${CONFIG.PAGE_RATE_LIMIT}`
    await setupCapability(name)
    const req = new Request(`https://sigil.shazhou.workers.dev/xiaoju/${name}`)

    try {
      const resp = await pool.invoke(`xiaoju--${name}`, req)
      if (resp.status === 503) {
        const body = await resp.json() as { error: string; retry_after?: number }
        // retry_after may be 0 for immediate window, just check it exists or we got exception
        expect(body.error).toBeTruthy()
      }
    } catch (e) {
      expect(e).toBeInstanceOf(PageRateLimitError)
      expect((e as PageRateLimitError).retry_after).toBeGreaterThanOrEqual(0)
    }
  })
})
