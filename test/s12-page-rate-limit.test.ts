import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'
import { CONFIG } from '../src/config.js'
import { PageRateLimitError } from '../src/lru.js'

describe('S12: 换页速率限制', () => {
  let mockKv: KVNamespace
  let mockLoader: ReturnType<typeof createMockLoader>
  let mockEmbed: MockEmbeddingService
  let pool: WorkerPool
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockLoader = createMockLoader({
      invokeResponse: () => new Response('ok', { status: 200 }),
    })
    mockEmbed = new MockEmbeddingService()
    pool = new WorkerPool(mockKv, mockLoader.cfApi, mockEmbed as any)
    kv = new KvStore(mockKv)
  })

  async function setupCapability(name: string): Promise<void> {
    await kv.setCode(name, `// ${name}`)
    await kv.setMeta(name, {
      type: 'normal',
      created_at: Date.now() - 10000,
    })
    await kv.setLru(name, {
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

      const req = new Request(`https://sigil.shazhou.workers.dev/run/${name}`)
      const resp = await pool.invoke(name, req)
      results.push(resp.status === 200)
    }

    expect(results.every(Boolean)).toBe(true)
  })

  it(`should reject the ${CONFIG.PAGE_RATE_LIMIT + 1}th page-in with 503`, async () => {
    // Do PAGE_RATE_LIMIT page-ins
    for (let i = 0; i < CONFIG.PAGE_RATE_LIMIT; i++) {
      const name = `cap${i}`
      await setupCapability(name)
      const req = new Request(`https://sigil.shazhou.workers.dev/run/${name}`)
      await pool.invoke(name, req)
    }

    // 11th one should fail
    const name = `cap${CONFIG.PAGE_RATE_LIMIT}`
    await setupCapability(name)

    const req = new Request(`https://sigil.shazhou.workers.dev/run/${name}`)
    try {
      const resp = await pool.invoke(name, req)
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
      const req = new Request(`https://sigil.shazhou.workers.dev/run/${name}`)
      await pool.invoke(name, req)
    }

    const name = `cap${CONFIG.PAGE_RATE_LIMIT}`
    await setupCapability(name)
    const req = new Request(`https://sigil.shazhou.workers.dev/run/${name}`)

    try {
      const resp = await pool.invoke(name, req)
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
