import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'

describe('S5: 调用不存在能力', () => {
  let pool: WorkerPool
  let mockCf: ReturnType<typeof createMockCfApi>

  beforeEach(() => {
    const mockKv = createMockKv()
    mockCf = createMockCfApi()
    pool = new WorkerPool(mockKv, mockCf.cfApi, new MockEmbeddingService() as any)
  })

  it('should return 404', async () => {
    const resp = await pool.invoke('nonexistent', new Request('https://sigil.shazhou.workers.dev/run/nonexistent'))
    expect(resp.status).toBe(404)
  })

  it('should return error JSON body', async () => {
    const resp = await pool.invoke('nonexistent', new Request('https://sigil.shazhou.workers.dev/run/nonexistent'))
    expect((await resp.json() as any).error).toBeTruthy()
  })

  it('should not call cfApi.invoke', async () => {
    await pool.invoke('nonexistent', new Request('https://sigil.shazhou.workers.dev/run/nonexistent'))
    expect(mockCf.invokeCalls()).toHaveLength(0)
  })

  it('should not call cfApi.updateSlotCode', async () => {
    await pool.invoke('nonexistent', new Request('https://sigil.shazhou.workers.dev/run/nonexistent'))
    expect(mockCf.updateSlotCodeCalls()).toHaveLength(0)
  })
})
