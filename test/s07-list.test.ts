import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockCfApi, makeRequest } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('S7: 列出能力', () => {
  let mockKv: KVNamespace
  let mockCf: ReturnType<typeof createMockCfApi>
  let pool: WorkerPool
  let auth: AuthModule
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockCf = createMockCfApi()
    pool = new WorkerPool(mockKv, mockCf.cfApi)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)

    await auth.setToken('deploy-token')

    // Deploy some capabilities (keep <= MAX_SLOTS=3 to avoid eviction)
    for (const name of ['ping', 'echo', 'hello']) {
      await pool.deploy({
        name,
        code: `// ${name}`,
        type: 'normal',
      })
    }
  })

  it('should return all capabilities', async () => {
    const req = makeRequest('GET', '/_api/list', {
      token: 'deploy-token',
    })

    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(200)

    const body = await resp.json() as { capabilities: Array<{ capability: string }> }
    expect(body.capabilities).toHaveLength(3)

    const names = body.capabilities.map(c => c.capability)
    expect(names).toContain('ping')
    expect(names).toContain('echo')
    expect(names).toContain('hello')
  })

  it('should include capability metadata in response', async () => {
    const caps = await pool.list()
    expect(caps.length).toBe(3)
    for (const cap of caps) {
      expect(cap.type).toBe('normal')
      expect(cap.deployed).toBe(true)
    }
  })
})
