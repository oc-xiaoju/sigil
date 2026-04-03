// Test setup — mock KV and CfApi

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

export interface MockCfApiCall {
  method: 'deployWorker' | 'deleteWorker' | 'invoke'
  args: unknown[]
}

/**
 * Mock CfApi that records calls without real CF API interaction.
 */
export function createMockCfApi(overrides?: {
  invokeResponse?: (workerName: string, request: Request) => Response
}) {
  const calls: MockCfApiCall[] = []
  const deployedWorkers = new Set<string>()

  return {
    calls,
    deployedWorkers,

    cfApi: {
      async deployWorker(name: string, code: string): Promise<void> {
        calls.push({ method: 'deployWorker', args: [name, code] })
        deployedWorkers.add(name)
      },

      async deleteWorker(name: string): Promise<void> {
        calls.push({ method: 'deleteWorker', args: [name] })
        deployedWorkers.delete(name)
      },

      getWorkerSubdomain(name: string): string {
        return `${name}.shazhou.workers.dev`
      },

      async invoke(workerName: string, request: Request): Promise<Response> {
        calls.push({ method: 'invoke', args: [workerName] })
        if (overrides?.invokeResponse) {
          return overrides.invokeResponse(workerName, request)
        }
        return new Response('mock response', { status: 200 })
      },
    },

    deployCalls(): string[] {
      return calls.filter(c => c.method === 'deployWorker').map(c => c.args[0] as string)
    },

    deleteCalls(): string[] {
      return calls.filter(c => c.method === 'deleteWorker').map(c => c.args[0] as string)
    },

    reset(): void {
      calls.length = 0
      deployedWorkers.clear()
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
