import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'

describe('S12: Dynamic Workers invoke（原 page-rate-limit）', () => {
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
    pool = new WorkerPool(mockKv, mockLoader.loader, mockEmbed as any)
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

  it('should invoke evicted capabilities without page-rate-limit', async () => {
    // With Dynamic Workers, there is no page rate limit — invoke always works.
    for (let i = 0; i < 15; i++) {
      const name = `cap${i}`
      await setupCapability(name)
      const req = new Request(`https://sigil.shazhou.workers.dev/run/${name}`)
      const resp = await pool.invoke(name, req)
      expect(resp.status).toBe(200)
    }
  })

  it('should mark cold-start capability as deployed after invoke', async () => {
    await setupCapability('cold')
    const lruBefore = await kv.getLru('cold')
    expect(lruBefore!.deployed).toBe(false)

    const req = new Request('https://sigil.shazhou.workers.dev/run/cold')
    await pool.invoke('cold', req)

    const lruAfter = await kv.getLru('cold')
    expect(lruAfter!.deployed).toBe(true)
  })
})
