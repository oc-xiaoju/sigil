import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'

describe('S5: 调用不存在的能力', () => {
  let mockKv: KVNamespace
  let mockCf: ReturnType<typeof createMockCfApi>
  let pool: WorkerPool

  beforeEach(() => {
    mockKv = createMockKv()
    mockCf = createMockCfApi()
    pool = new WorkerPool(mockKv, mockCf.cfApi)
  })

  it('should return 404 for nonexistent capability', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/nonexistent')
    const resp = await pool.invoke('nonexistent', req)
    expect(resp.status).toBe(404)
  })

  it('should return error JSON body', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/nonexistent')
    const resp = await pool.invoke('nonexistent', req)
    const body = await resp.json() as { error: string }
    expect(body.error).toBeTruthy()
  })

  it('should not call deployWorker for nonexistent', async () => {
    const req = new Request('https://sigil.shazhou.workers.dev/run/nonexistent')
    await pool.invoke('nonexistent', req)
    expect(mockCf.deployCalls()).toHaveLength(0)
  })
})
