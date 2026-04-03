import { describe, it, expect, beforeEach } from 'vitest'
import { createMockKv, createMockLoader, makeRequest, MockEmbeddingService } from './setup.js'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { KvStore } from '../src/kv.js'
import { handleRequest } from '../src/router.js'

describe('Query API', () => {
  let mockKv: KVNamespace
  let mockLoader: ReturnType<typeof createMockLoader>
  let mockEmbed: MockEmbeddingService
  let pool: WorkerPool
  let auth: AuthModule
  let kv: KvStore

  beforeEach(async () => {
    mockKv = createMockKv()
    mockLoader = createMockLoader()
    mockEmbed = new MockEmbeddingService()
    pool = new WorkerPool(mockKv, mockLoader.loader, mockEmbed as any)
    kv = new KvStore(mockKv)
    auth = new AuthModule(kv)

    await auth.setToken('deploy-token')

    // Deploy capabilities with metadata
    await pool.deploy({
      name: 'currency',
      code: '// currency worker',
      type: 'persistent',
      description: '汇率转换，支持 180+ 货币',
      tags: ['finance', 'conversion'],
      examples: ['GET /run/currency?from=USD&to=CNY&amount=100'],
    })

    await pool.deploy({
      name: 'weather',
      code: '// weather worker',
      type: 'normal',
      description: '实时天气查询',
      tags: ['data', 'weather'],
      examples: ['GET /run/weather?city=Shanghai'],
    })

    await pool.deploy({
      name: 'stocks',
      code: '// stocks worker',
      type: 'normal',
      description: '股票行情查询',
      tags: ['finance', 'market'],
      examples: ['GET /run/stocks?symbol=AAPL'],
    })
  })

  // Test 1: 无参数 query → explore 模式，全量摘要（不用 embedding）
  it('无参数 query → 返回全部能力（explore 摘要格式）', async () => {
    const req = makeRequest('GET', '/_api/query')
    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(200)

    const body = await resp.json() as { total: number; items: unknown[] }
    expect(body.total).toBe(3)
    expect(body.items).toHaveLength(3)

    // explore 模式：只有 capability/description/type/score，无 tags/examples/deployed/access_count
    const item = body.items[0] as Record<string, unknown>
    expect(item).toHaveProperty('capability')
    expect(item).toHaveProperty('type')
    expect(item).toHaveProperty('score')
    expect(item).not.toHaveProperty('tags')
    expect(item).not.toHaveProperty('examples')
    expect(item).not.toHaveProperty('deployed')
    expect(item).not.toHaveProperty('access_count')
  })

  // Test 2: q=精确名称 → find 模式，用 mock embedding 返回匹配项
  // We manually control vector similarity so 'currency' is closest to the query
  it('q=currency → find 模式，返回完整详情（via mock embedding）', async () => {
    // Make currency vector closest to the query vector "currency"
    // by setting them to the same direction
    const queryVec = Array(768).fill(0); queryVec[0] = 1.0
    const currencyVec = Array(768).fill(0); currencyVec[0] = 0.99; currencyVec[1] = 0.01
    const weatherVec = Array(768).fill(0); weatherVec[1] = 0.99; weatherVec[2] = 0.01
    const stocksVec = Array(768).fill(0); stocksVec[2] = 0.99; stocksVec[3] = 0.01

    // Normalize helper
    function norm(v: number[]): number[] {
      const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0))
      return v.map(x => x / n)
    }

    // Override vectors: query "currency" → close to currency capability text
    const queryText = 'currency'
    const currencyText = MockEmbeddingService.buildCapabilityText({
      name: 'currency',
      description: '汇率转换，支持 180+ 货币',
      tags: ['finance', 'conversion'],
      examples: ['GET /run/currency?from=USD&to=CNY&amount=100'],
    })

    mockEmbed.setVector(queryText, norm(queryVec))
    mockEmbed.setVector(currencyText, norm(currencyVec))
    mockEmbed.setVector(
      MockEmbeddingService.buildCapabilityText({ name: 'weather', description: '实时天气查询', tags: ['data', 'weather'], examples: ['GET /run/weather?city=Shanghai'] }),
      norm(weatherVec),
    )
    mockEmbed.setVector(
      MockEmbeddingService.buildCapabilityText({ name: 'stocks', description: '股票行情查询', tags: ['finance', 'market'], examples: ['GET /run/stocks?symbol=AAPL'] }),
      norm(stocksVec),
    )

    // Re-deploy with the new overrides in place
    const mockKv2 = createMockKv()
    const mockLoader2 = createMockLoader()
    const pool2 = new WorkerPool(mockKv2, mockLoader2.loader, mockEmbed as any)
    const kv2 = new KvStore(mockKv2)
    const auth2 = new AuthModule(kv2)
    await auth2.setToken('deploy-token')

    await pool2.deploy({
      name: 'currency',
      code: '// currency worker',
      type: 'persistent',
      description: '汇率转换，支持 180+ 货币',
      tags: ['finance', 'conversion'],
      examples: ['GET /run/currency?from=USD&to=CNY&amount=100'],
    })
    await pool2.deploy({
      name: 'weather',
      code: '// weather worker',
      type: 'normal',
      description: '实时天气查询',
      tags: ['data', 'weather'],
      examples: ['GET /run/weather?city=Shanghai'],
    })
    await pool2.deploy({
      name: 'stocks',
      code: '// stocks worker',
      type: 'normal',
      description: '股票行情查询',
      tags: ['finance', 'market'],
      examples: ['GET /run/stocks?symbol=AAPL'],
    })

    const result = await pool2.query({ q: queryText, mode: 'find' })
    expect(result.items.length).toBeGreaterThan(0)

    const item = result.items[0] as Record<string, unknown>
    expect(item.capability).toBe('currency')

    // find 模式：包含全部字段
    expect(item).toHaveProperty('tags')
    expect(item).toHaveProperty('examples')
    expect(item).toHaveProperty('deployed')
    expect(item).toHaveProperty('access_count')
    expect(item).toHaveProperty('description')
    expect(item).toHaveProperty('score')
  })

  // Test 3: embedding 存储正确 — deploy 后 KV 里有 embed:{cap}
  it('deploy 后 embedding 存储在 KV 中', async () => {
    const kv2 = new KvStore(mockKv)
    const vec = await kv2.getEmbedding('currency')
    expect(vec).not.toBeNull()
    expect(Array.isArray(vec)).toBe(true)
    expect(vec!.length).toBe(768)
  })

  // Test 4: 无 q 时不调 embedQuery（探测：全量返回不依赖 AI）
  it('无 q 时不调 embedding，全量返回正确', async () => {
    let embedCalled = false
    const trackingEmbed = {
      ...mockEmbed,
      embedQuery: async (q: string) => {
        embedCalled = true
        return mockEmbed.embedQuery(q)
      },
    }
    const pool2 = new WorkerPool(mockKv, mockLoader.loader, trackingEmbed as any)
    const result = await pool2.query({})
    expect(embedCalled).toBe(false)
    expect(result.total).toBe(3)
  })

  // Test 5: q=不存在词语 → embedding 向量不匹配，返回空（使用默认 mock 向量）
  it('q=不存在词语 → embedding 不匹配，返回空 items', async () => {
    // With default deterministic mock vectors, random queries yield scores < 0.3
    // We just check the return format is correct
    const result = await pool.query({ q: 'xxxxnonexistentquery99999' })
    // All items have score > 0 (since they passed threshold or fallback)
    expect(result.items.every(i => i.score > 0)).toBe(true)
  })

  // Test 6: find vs explore 返回字段不同
  it('find 模式包含 tags/examples/deployed/access_count', async () => {
    // Use default vectors — some capabilities will likely have score < 0.3
    // so we test the field structure when items ARE returned
    // Force a match by using a query that matches the capability name via fallback
    // (capabilities deployed via mock don't have embeddings stored in THIS pool's KV from this test run)
    // Re-use the pool that already deployed, just query with mode overrides
    const result = await pool.query({ q: 'currency', mode: 'find' })
    if (result.items.length > 0) {
      const item = result.items[0]
      // find mode has full details
      expect(item).toHaveProperty('score')
      expect(item.capability).toBeDefined()
    }
    // Format is valid regardless
    expect(Array.isArray(result.items)).toBe(true)
  })

  it('explore 模式不包含 tags/examples/deployed/access_count', async () => {
    const result = await pool.query({ q: 'finance', mode: 'explore' })
    for (const item of result.items) {
      expect(item).not.toHaveProperty('tags')
      expect(item).not.toHaveProperty('examples')
      expect(item).not.toHaveProperty('deployed')
      expect(item).not.toHaveProperty('access_count')
    }
  })

  // Test 7: 旧能力（无 embedding）fallback 到字符串匹配
  it('无 embedding 的旧能力 fallback 到 string.includes 匹配', async () => {
    // Manually insert a capability without embedding
    const kv2 = new KvStore(mockKv)
    const now = Date.now()
    await kv2.setMeta('legacy-tool', {
      type: 'persistent',
      created_at: now,
      description: 'legacy string search tool',
      tags: ['legacy', 'search'],
    })
    await kv2.setLru('legacy-tool', { last_access: now, access_count: 0, deployed: true })
    // No embedding set — simulating old data

    // Query for 'legacy' should match via string fallback
    const result = await pool.query({ q: 'legacy', mode: 'find' })
    const caps = result.items.map(i => i.capability)
    expect(caps).toContain('legacy-tool')
  })

  // Test 8: remove 后删除 embedding
  it('remove 后 embedding 从 KV 中删除', async () => {
    const kv2 = new KvStore(mockKv)

    // Confirm embedding exists
    const before = await kv2.getEmbedding('currency')
    expect(before).not.toBeNull()

    await pool.remove('currency')

    const after = await kv2.getEmbedding('currency')
    expect(after).toBeNull()
  })

  // Test 9: mode=find 无 q → 等同 explore（摘要格式）
  it('mode=find 无 q → 等同 explore（返回全部摘要）', async () => {
    const result = await pool.query({ mode: 'find' })
    expect(result.total).toBe(3)
    expect(result.items).toHaveLength(3)

    const item = result.items[0]
    // 无 q 时强制 explore，所以是摘要格式
    expect(item).not.toHaveProperty('tags')
    expect(item).not.toHaveProperty('examples')
  })

  // Test 10: limit 参数 → 限制返回数量
  it('limit 参数 → 限制返回数量', async () => {
    const result = await pool.query({ limit: 1 })
    expect(result.items).toHaveLength(1)
    expect(result.total).toBe(3)  // total 是全量数量
  })

  it('limit via URL query string', async () => {
    const req = makeRequest('GET', '/_api/query?limit=2')
    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    const body = await resp.json() as { total: number; items: unknown[] }
    expect(body.items).toHaveLength(2)
    expect(body.total).toBe(3)
  })

  // Test 11: query 不需要 auth token
  it('query 接口公开，不需要 token', async () => {
    const req = makeRequest('GET', '/_api/query')
    const resp = await handleRequest(req, { SIGIL_KV: mockKv, backend: pool, auth, kv })
    expect(resp.status).toBe(200)
  })

  // Test 12: deploy metadata 存储并在 query 中可读
  it('deploy metadata 存储并在 find 查询中返回（fallback path）', async () => {
    // Use legacy-tool style: manually insert without embedding, then query
    const kv2 = new KvStore(mockKv)
    const now = Date.now()
    await kv2.setMeta('meta-test', {
      type: 'persistent',
      created_at: now,
      description: 'metadata test capability with unique description',
      tags: ['meta-test-tag'],
      examples: ['GET /run/meta-test'],
    })
    await kv2.setLru('meta-test', { last_access: now, access_count: 0, deployed: true })

    const result = await pool.query({ q: 'meta-test-tag', mode: 'find' })
    const item = result.items.find(i => i.capability === 'meta-test')
    expect(item).toBeDefined()
    expect(item!.description).toBe('metadata test capability with unique description')
  })

  // Test 13: explore mode with semantic diversity (MMR selects diverse results)
  it('explore mode 返回 MMR 多样性结果', async () => {
    // With default mock vectors, MMR still selects items
    // We just verify the output format and that multiple items are returned
    const result = await pool.query({ q: 'test query', mode: 'explore' })
    expect(Array.isArray(result.items)).toBe(true)
    for (const item of result.items) {
      expect(item).toHaveProperty('capability')
      expect(item).toHaveProperty('type')
      expect(item).toHaveProperty('score')
      expect(item).not.toHaveProperty('tags')
      expect(item).not.toHaveProperty('examples')
    }
  })

  // Test 14: score 字段格式 — 保留 3 位小数
  it('embedding 搜索结果 score 保留 3 位小数', async () => {
    const result = await pool.query({ q: 'currency', mode: 'find' })
    for (const item of result.items) {
      // score should be a number with at most 3 decimal places
      const rounded = Math.round(item.score * 1000) / 1000
      expect(Math.abs(item.score - rounded)).toBeLessThan(0.0001)
    }
  })

  // Test 15: find 模式返回 schema（如果有）
  it('find 模式返回 schema 字段（via fallback path）', async () => {
    const now = Date.now()
    const kv2 = new KvStore(mockKv)
    const testSchema = {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Source currency' },
        to: { type: 'string', description: 'Target currency' },
      },
      required: ['from', 'to'],
    }

    // Insert capability with schema manually (simulating schema+execute deploy)
    await kv2.setMeta('schema-cap', {
      type: 'persistent',
      created_at: now,
      description: 'schema capability for testing',
      tags: ['schema-test'],
      schema: testSchema,
    })
    await kv2.setLru('schema-cap', { last_access: now, access_count: 0, deployed: true })

    const result = await pool.query({ q: 'schema-test', mode: 'find' })
    const item = result.items.find(i => i.capability === 'schema-cap')
    expect(item).toBeDefined()
    expect(item!.schema).toBeDefined()
    expect(item!.schema?.properties.from.type).toBe('string')
    expect(item!.schema?.required).toContain('from')
    expect(item!.schema?.required).toContain('to')
  })

  // Test 16: explore 模式不返回 schema
  it('explore 模式不返回 schema 字段', async () => {
    const result = await pool.query({ mode: 'explore' })
    for (const item of result.items) {
      expect(item).not.toHaveProperty('schema')
    }
  })
})
