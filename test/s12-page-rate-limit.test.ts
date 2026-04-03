import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { KvStore } from '../src/kv.js'
import { CONFIG } from '../src/config.js'

describe('S12: 换页操作（无速率限制）', () => {
  let mockKv: KVNamespace
  let pool: WorkerPool
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    const mockCf = createMockCfApi({ invokeResponse: () => new Response('ok', { status: 200 }) })
    pool = new WorkerPool(mockKv, mockCf.cfApi, new MockEmbeddingService() as any)
    kv = new KvStore(mockKv)
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) await kv.setSlot(i, { capability: null, status: 'free' })
  })

  it('should allow multiple sequential deploys', async () => {
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) {
      const result = await pool.deploy({ name: 'seq' + i, code: '// seq' + i, type: 'normal' })
      expect(result.capability).toBe('seq' + i)
    }
  })

  it('should succeed page-in for cold capability', async () => {
    await kv.setCode('cold', '// cold')
    await kv.setMeta('cold', { type: 'normal', created_at: Date.now() - 10000 })
    await kv.setLru('cold', { last_access: Date.now() - 10000, access_count: 0, deployed: false })
    const resp = await pool.invoke('cold', new Request('https://sigil.shazhou.workers.dev/run/cold'))
    expect(resp.status).toBe(200)
  })
})
