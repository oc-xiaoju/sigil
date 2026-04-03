import { describe, it, expect, beforeEach } from 'vitest'
import { WorkerPool } from '../src/backend/worker-pool.js'
import { AuthModule } from '../src/auth.js'
import { createMockKv, createMockLoader, MockEmbeddingService } from './setup.js'
import { handleRequest } from '../src/router.js'
import { KvStore } from '../src/kv.js'

describe('AMD Capabilities', () => {
  let kv: KVNamespace
  let kvStore: KvStore
  let loader: ReturnType<typeof createMockLoader>
  let embeddingService: MockEmbeddingService
  let backend: WorkerPool
  let auth: AuthModule
  let env: any

  beforeEach(() => {
    kv = createMockKv()
    kvStore = new KvStore(kv)
    loader = createMockLoader()
    embeddingService = new MockEmbeddingService()
    backend = new WorkerPool(kv, loader.loader, embeddingService)
    auth = new AuthModule(kvStore)
    
    env = {
      SIGIL_KV: kv,
      backend,
      auth,
      kv: kvStore,
    }

    // Set deploy token
    auth.setToken('test-token')
  })

  describe('Basic dependency injection', () => {
    it('should deploy capability with single dependency', async () => {
      // Deploy dependency first
      await backend.deploy({
        name: 'dep-a',
        execute: 'return "value-a";',
        type: 'normal',
        description: 'Dependency A',
      })

      // Deploy capability that requires dep-a
      const result = await backend.deploy({
        name: 'main-cap',
        execute: 'const result = await deps["dep-a"](); return `Main: ${result}`;',
        type: 'normal',
        description: 'Main capability',
        requires: ['dep-a'],
      })

      expect(result.capability).toBe('main-cap')
      expect(result.url).toMatch(/\/run\/main-cap$/)
    })

    it('should generate correct code structure with dependencies', async () => {
      // Deploy dependency
      await backend.deploy({
        name: 'token-provider',
        schema: {
          type: 'object',
          properties: {
            service: { type: 'string', default: 'github' }
          },
        },
        execute: 'return `token-${input.service}`;',
        type: 'normal',
      })

      await backend.deploy({
        name: 'api-client',
        schema: {
          type: 'object',
          properties: {
            endpoint: { type: 'string' }
          },
          required: ['endpoint'],
        },
        execute: `
          const token = await deps["token-provider"]({ service: "github" });
          return { endpoint: input.endpoint, token };
        `,
        type: 'normal',
        requires: ['token-provider'],
      })

      const code = await kvStore.getCode('api-client')
      expect(code).toContain('const deps = {')
      expect(code).toContain("'token-provider':")
      expect(code).toContain('async (params = {}) =>')
      expect(code).toContain('(input, deps) =>')
    })
  })

  describe('Multiple dependencies', () => {
    it('should handle multiple dependencies', async () => {
      // Deploy dependencies
      await backend.deploy({
        name: 'dep-b',
        execute: 'return "value-b";',
        type: 'normal',
      })

      await backend.deploy({
        name: 'dep-c', 
        execute: 'return "value-c";',
        type: 'normal',
      })

      // Deploy main capability
      const result = await backend.deploy({
        name: 'multi-dep',
        execute: `
          const b = await deps["dep-b"]();
          const c = await deps["dep-c"]();
          return \`\${b} and \${c}\`;
        `,
        type: 'normal',
        requires: ['dep-b', 'dep-c'],
      })

      expect(result.capability).toBe('multi-dep')
      
      const code = await kvStore.getCode('multi-dep')
      expect(code).toContain("'dep-b':")
      expect(code).toContain("'dep-c':")
    })
  })

  describe('Chain dependencies', () => {
    it('should handle chained dependencies (A requires B, B requires C)', async () => {
      // Deploy C (no deps)
      await backend.deploy({
        name: 'base-service',
        execute: 'return "base-value";',
        type: 'normal',
      })

      // Deploy B (requires C)
      await backend.deploy({
        name: 'middleware',
        execute: `
          const base = await deps["base-service"]();
          return \`middleware(\${base})\`;
        `,
        type: 'normal',
        requires: ['base-service'],
      })

      // Deploy A (requires B)
      const result = await backend.deploy({
        name: 'top-level',
        execute: `
          const mid = await deps["middleware"]();
          return \`top(\${mid})\`;
        `,
        type: 'normal',
        requires: ['middleware'],
      })

      expect(result.capability).toBe('top-level')
      
      // Should contain both direct and transitive dependencies
      const code = await kvStore.getCode('top-level')
      expect(code).toContain("'middleware':")
      expect(code).toContain("'base-service':")
    })
  })

  describe('Circular dependency detection', () => {
    it('should detect simple circular dependency via self-reference', async () => {
      // Try to create a capability that depends on itself
      await expect(backend.deploy({
        name: 'self-ref',
        execute: 'const self = await deps["self-ref"](); return `self-${self}`;',
        type: 'normal',
        requires: ['self-ref'],
      })).rejects.toThrow('Circular dependency detected: self-ref -> self-ref')
    })

    it('should work with real dependencies but detect actual cycle', async () => {
      // Create a proper test environment for cycle detection
      // Step 1: Create base capabilities 
      await backend.deploy({ name: 'base-1', execute: 'return "base1";', type: 'normal' })
      await backend.deploy({ name: 'base-2', execute: 'return "base2";', type: 'normal' })
      
      // Step 2: Create mid-level that depends on base
      await backend.deploy({
        name: 'mid-1',
        execute: 'const b1 = await deps["base-1"](); return `mid1-${b1}`;',
        type: 'normal',
        requires: ['base-1']
      })

      // Step 3: Now let's simulate creating a cycle by having a test resolver
      // that tracks dependencies in a simple way
      const visited = new Set<string>(['base-1'])
      const path = ['base-1']
      
      // Simulate what would happen if base-1 tried to depend on mid-1
      if (visited.has('mid-1')) {
        const cycle = [...path, 'mid-1'].join(' -> ')
        expect(cycle).toContain('base-1 -> mid-1')
      }
      
      // The actual way to test would be to create this scenario:
      // Let's remove base-1 and try to make it depend on mid-1
      await backend.remove('base-1')
      
      // This should now detect circular dependency: base-1 -> mid-1 -> base-1
      await expect(backend.deploy({
        name: 'base-1', 
        execute: 'const mid = await deps["mid-1"](); return `new-base1-${mid}`;',
        type: 'normal',
        requires: ['mid-1']
      })).rejects.toThrow('Circular dependency detected')
    })
  })

  describe('Backward compatibility', () => {
    it('should not affect capabilities without dependencies', async () => {
      const result = await backend.deploy({
        name: 'no-deps',
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string', default: 'hello' }
          },
        },
        execute: 'return `No deps: ${input.message}`;',
        type: 'normal',
      })

      expect(result.capability).toBe('no-deps')
      
      const code = await kvStore.getCode('no-deps')
      expect(code).not.toContain('const deps = {')
      expect(code).toContain('(input) => {')
    })

    it('should handle full code deployment mode', async () => {
      const workerCode = `
        export default {
          async fetch(request) {
            return new Response('custom worker code');
          }
        };
      `

      const result = await backend.deploy({
        name: 'custom-worker',
        code: workerCode,
        type: 'normal',
      })

      expect(result.capability).toBe('custom-worker')
      
      const code = await kvStore.getCode('custom-worker')
      expect(code).toBe(workerCode)
    })
  })

  describe('Error handling', () => {
    it('should fail when dependency not found', async () => {
      await expect(backend.deploy({
        name: 'missing-dep',
        execute: 'return await deps["nonexistent"]();',
        type: 'normal',
        requires: ['nonexistent'],
      })).rejects.toThrow('Dependency not found: nonexistent')
    })

    it('should handle empty requires array', async () => {
      const result = await backend.deploy({
        name: 'empty-requires',
        execute: 'return "no deps";',
        type: 'normal',
        requires: [],
      })

      expect(result.capability).toBe('empty-requires')
      
      const code = await kvStore.getCode('empty-requires')
      expect(code).not.toContain('const deps = {')
    })
  })

  describe('API integration', () => {
    it('should accept requires field via router', async () => {
      // Reset cooldown before test by setting last deploy time to far past
      await kvStore.setLastDeployTime(Date.now() - 60000) // 1 minute ago

      // Deploy dependency via API
      const depRequest = new Request('https://test.com/_api/deploy', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'api-dep',
          execute: 'return "api-dependency";',
          type: 'normal',
        }),
      })

      const depResponse = await handleRequest(depRequest, env)
      expect(depResponse.status).toBe(201)

      // Reset cooldown again 
      await kvStore.setLastDeployTime(Date.now() - 60000) // 1 minute ago

      // Deploy main capability with requires
      const mainRequest = new Request('https://test.com/_api/deploy', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token', 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'api-main',
          execute: 'const dep = await deps["api-dep"](); return `Main: ${dep}`;',
          type: 'normal',
          requires: ['api-dep'],
        }),
      })

      const mainResponse = await handleRequest(mainRequest, env)
      expect(mainResponse.status).toBe(201)

      const result = await mainResponse.json()
      expect(result.capability).toBe('api-main')
    })

    it('should store requires in metadata', async () => {
      // Deploy dependency first
      await backend.deploy({
        name: 'some-dep',
        execute: 'return "dependency";',
        type: 'normal',
      })

      // Then deploy main capability  
      await backend.deploy({
        name: 'meta-test',
        execute: 'return await deps["some-dep"]();',
        type: 'normal', 
        requires: ['some-dep'],
      })

      const meta = await kvStore.getMeta('meta-test')
      expect(meta?.requires).toEqual(['some-dep'])
    })
  })
})