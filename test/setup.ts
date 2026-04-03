// Refactored: MockCfApi replaced with MockLoader (Dynamic Workers LOADER binding).
// CfApi interface and subdomain helpers removed; invoke now uses LOADER.get().

import { EmbeddingService } from '../src/embedding.js'

export interface MockKvEntry {
  value: string
  metadata?: unknown
}

/**
 * In-memory KVNamespace mock.
 */
export function createMockKv(): KVNamespace {
  const store = new Map<string, MockKvEntry>()

  return {
    async get(key: string, options?: { type?: string } | string): Promise<unknown> {
      const entry = store.get(key)
      if (!entry) return null

      const type = typeof options === 'string' ? options : options?.type ?? 'text'

      if (type === 'json') {
        try {
          return JSON.parse(entry.value)
        } catch {
          return null
        }
      }
      if (type === 'arrayBuffer') {
        return new TextEncoder().encode(entry.value).buffer
      }
      if (type === 'stream') {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(entry.value))
            controller.close()
          },
        })
      }
      return entry.value
    },

    async getWithMetadata(key: string, options?: { type?: string } | string): Promise<{ value: unknown; metadata: unknown }> {
      const entry = store.get(key)
      if (!entry) return { value: null, metadata: null }
      const type = typeof options === 'string' ? options : options?.type ?? 'text'
      let value: unknown = entry.value
      if (type === 'json') value = JSON.parse(entry.value)
      return { value, metadata: entry.metadata ?? null }
    },

    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: { expiration?: number; expirationTtl?: number; metadata?: unknown }): Promise<void> {
      let strVal: string
      if (typeof value === 'string') {
        strVal = value
      } else if (value instanceof ArrayBuffer) {
        strVal = new TextDecoder().decode(value)
      } else {
        strVal = String(value)
      }
      store.set(key, { value: strVal, metadata: options?.metadata })
    },

    async delete(key: string): Promise<void> {
      store.delete(key)
    },

    async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KVNamespaceListResult<unknown, string>> {
      const prefix = options?.prefix ?? ''
      const limit = options?.limit ?? 1000
      const keys = Array.from(store.keys())
        .filter(k => k.startsWith(prefix))
        .slice(0, limit)
        .map(name => ({ name, expiration: undefined, metadata: undefined }))

      return {
        keys,
        list_complete: true,
        cursor: '',
        cacheStatus: null,
      }
    },
  } as unknown as KVNamespace
}

export interface MockLoaderGetCall {
  workerId: string
}

/**
 * Mock Dynamic Workers LOADER binding.
 * Records LOADER.get() calls and returns a mock Worker whose
 * getEntrypoint().fetch() delegates to the provided invokeResponse factory.
 */
export function createMockLoader(overrides?: {
  invokeResponse?: (workerId: string, request: Request) => Response | Promise<Response>
}) {
  const getCalls: MockLoaderGetCall[] = []

  return {
    getCalls,

    loader: {
      async get(workerId: string, _loadFn: () => Promise<{ code: string }>) {
        getCalls.push({ workerId })
        return {
          getEntrypoint() {
            return {
              async fetch(request: Request): Promise<Response> {
                if (overrides?.invokeResponse) {
                  return overrides.invokeResponse(workerId, request)
                }
                return new Response('mock response', { status: 200 })
              },
            }
          },
        }
      },
    },

    loaderCalls(): string[] {
      return getCalls.map(c => c.workerId)
    },

    reset(): void {
      getCalls.length = 0
    },
  }
}

/**
 * Create a test request helper.
 */
export function makeRequest(
  method: string,
  path: string,
  options?: {
    body?: unknown
    token?: string
    headers?: Record<string, string>
  },
): Request {
  const url = `https://sigil.shazhou.workers.dev${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options?.headers,
  }

  if (options?.token) {
    headers['Authorization'] = `Bearer ${options.token}`
  }

  const init: RequestInit = {
    method,
    headers,
  }

  if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body)
  }

  return new Request(url, init)
}

// Simple deterministic hash (for mock vectors)
function simpleHash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h
}

// Generate a deterministic unit vector of given dimension
function generateDeterministicVector(seed: number, dim: number): number[] {
  const vec: number[] = []
  let s = seed
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    vec.push((s / 0xffffffff) * 2 - 1)
  }
  const norm = Math.sqrt(vec.reduce((a, x) => a + x * x, 0))
  return vec.map(x => x / norm)
}

/**
 * Mock EmbeddingService for unit tests.
 * Returns deterministic vectors. Supports manual vector overrides
 * to simulate semantic similarity.
 */
export class MockEmbeddingService {
  private overrides = new Map<string, number[]>()

  static buildCapabilityText(params: any): string {
    return EmbeddingService.buildCapabilityText(params)
  }

  setVector(textOrKey: string, vector: number[]): void {
    this.overrides.set(textOrKey, vector)
  }

  async embed(text: string): Promise<number[]> {
    if (this.overrides.has(text)) {
      return this.overrides.get(text)!
    }
    const hash = simpleHash(text)
    return generateDeterministicVector(hash, 768)
  }

  async embedQuery(query: string): Promise<number[]> {
    if (this.overrides.has(query)) {
      return this.overrides.get(query)!
    }
    return this.embed(query)
  }
}