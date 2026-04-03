import { EmbeddingService } from '../src/embedding.js'
import type { CfApi } from '../src/cf-api.js'

export interface MockKvEntry { value: string; metadata?: unknown }

export interface MockLoaderGetCall {
  workerId: string;
  getCodeCalled: boolean;
}

interface WorkerStub {
  invoke(request: Request): Promise<Response>;
}

interface WorkerLoader {
  get(workerId: string, getCode?: () => any): WorkerStub;
}

export function createMockKv(): KVNamespace {
  const store = new Map<string, MockKvEntry>()
  return {
    async get(key: string, options?: { type?: string } | string): Promise<unknown> {
      const entry = store.get(key); if (!entry) return null
      const type = typeof options === 'string' ? options : (options as any)?.type ?? 'text'
      if (type === 'json') { try { return JSON.parse(entry.value) } catch { return null } }
      return entry.value
    },
    async getWithMetadata(key: string, options?: any): Promise<{ value: unknown; metadata: unknown }> {
      const entry = store.get(key); if (!entry) return { value: null, metadata: null }
      const type = typeof options === 'string' ? options : options?.type ?? 'text'
      let value: unknown = entry.value; if (type === 'json') value = JSON.parse(entry.value)
      return { value, metadata: entry.metadata ?? null }
    },
    async put(key: string, value: any, options?: any): Promise<void> {
      let strVal = typeof value === 'string' ? value : (value instanceof ArrayBuffer ? new TextDecoder().decode(value) : String(value))
      store.set(key, { value: strVal, metadata: options?.metadata })
    },
    async delete(key: string): Promise<void> { store.delete(key) },
    async list(options?: any): Promise<KVNamespaceListResult<unknown, string>> {
      const prefix = options?.prefix ?? ''; const limit = options?.limit ?? 1000
      const keys = Array.from(store.keys()).filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name, expiration: undefined, metadata: undefined }))
      return { keys, list_complete: true, cursor: '', cacheStatus: null }
    },
  } as unknown as KVNamespace
}

export function createMockCfApi(overrides?: {
  invokeResponse?: (slotIndex: number, request: Request) => Response | Promise<Response>
}) {
  const calls: Array<{ method: string; slotIndex: number; code?: string }> = []
  const cfApi: CfApi = {
    async updateSlotCode(slotIndex: number, code: string): Promise<void> { calls.push({ method: 'updateSlotCode', slotIndex, code }) },
    async initSlot(slotIndex: number): Promise<void> { calls.push({ method: 'initSlot', slotIndex }) },
    getSlotSubdomain(slotIndex: number): string { return `s-slot-${slotIndex}.test.workers.dev` },
    async invoke(slotIndex: number, request: Request): Promise<Response> {
      calls.push({ method: 'invoke', slotIndex })
      if (overrides?.invokeResponse) return overrides.invokeResponse(slotIndex, request)
      return new Response('mock response', { status: 200 })
    },
  }
  return {
    cfApi, calls,
    updateSlotCodeCalls() { return calls.filter(c => c.method === 'updateSlotCode').map(c => ({ slotIndex: c.slotIndex, code: c.code! })) },
    invokeCalls() { return calls.filter(c => c.method === 'invoke').map(c => c.slotIndex) },
    reset() { calls.length = 0 },
  }
}

export function makeRequest(method: string, path: string, options?: {
  body?: unknown; token?: string; headers?: Record<string, string>
}): Request {
  const url = `https://sigil.shazhou.workers.dev${path}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...options?.headers }
  if (options?.token) headers['Authorization'] = `Bearer ${options.token}`
  const init: RequestInit = { method, headers }
  if (options?.body !== undefined) init.body = JSON.stringify(options.body)
  return new Request(url, init)
}

function simpleHash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h
}
function generateDeterministicVector(seed: number, dim: number): number[] {
  const vec: number[] = []; let s = seed
  for (let i = 0; i < dim; i++) { s = (s * 1664525 + 1013904223) >>> 0; vec.push((s / 0xffffffff) * 2 - 1) }
  const norm = Math.sqrt(vec.reduce((a, x) => a + x * x, 0))
  return vec.map(x => x / norm)
}

export class MockEmbeddingService {
  private overrides = new Map<string, number[]>()
  static buildCapabilityText(params: any): string { return EmbeddingService.buildCapabilityText(params) }
  setVector(k: string, v: number[]): void { this.overrides.set(k, v) }
  async embed(text: string): Promise<number[]> {
    if (this.overrides.has(text)) return this.overrides.get(text)!
    return generateDeterministicVector(simpleHash(text), 768)
  }
  async embedQuery(q: string): Promise<number[]> {
    if (this.overrides.has(q)) return this.overrides.get(q)!
    return this.embed(q)
  }
}
