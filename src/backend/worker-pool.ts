// Pre-allocated slot pool architecture — zero DNS latency.
import type { SigilBackend, DeployParams, DeployResult, Capability, BackendStatus, QueryParams, QueryResult, QueryItem } from './types.js'
import type { CfApi } from '../cf-api.js'
import { KvStore } from '../kv.js'
import { LruScheduler } from '../lru.js'
import { CONFIG } from '../config.js'
import { EmbeddingService, cosineSimilarity, mmrSelect } from '../embedding.js'
import { IDLE_WORKER_CODE } from '../cf-api.js'

export type { CfApi }

export class WorkerPool implements SigilBackend {
  private kv: KvStore
  private lru: LruScheduler
  private embeddingService: EmbeddingService
  private config = CONFIG

  constructor(kv: KVNamespace, private cfApi: CfApi, embeddingService: EmbeddingService) {
    this.kv = new KvStore(kv)
    this.lru = new LruScheduler(this.kv)
    this.embeddingService = embeddingService
  }

  private async generateHash(input: string): Promise<string> {
    const data = new TextEncoder().encode(input)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, this.config.HASH_LENGTH)
  }

  private async acquireSlot(): Promise<[number, string | undefined]> {
    let freeSlot = await this.kv.findFreeSlot()
    let evicted: string | undefined
    if (freeSlot === null) {
      const candidate = await this.lru.findEvictionCandidate()
      if (!candidate) throw new Error('No eviction candidate found')
      await this.evictCapability(candidate.capability)
      evicted = candidate.capability
      await this.kv.incrementEvictionCount()
      freeSlot = await this.kv.findFreeSlot()
      if (freeSlot === null) throw new Error('No free slot after eviction')
    }
    return [freeSlot, evicted]
  }

  private async evictCapability(capability: string): Promise<void> {
    const route = await this.kv.getRoute(capability)
    if (route) {
      await this.cfApi.updateSlotCode(route.slot, IDLE_WORKER_CODE)
      await this.kv.setSlot(route.slot, { capability: null, status: 'free' })
      await this.kv.deleteRoute(capability)
    }
    const lru = await this.kv.getLru(capability)
    if (lru) await this.kv.setLru(capability, { ...lru, deployed: false })
  }

  async deploy(params: DeployParams): Promise<DeployResult> {
    const { name, code, schema, type, ttl, bindings, description, tags, examples } = params
    if (!code) throw new Error('deploy: code is required')
    const capability = name === null ? 't-' + await this.generateHash(code + Date.now()) : name
    const now = Date.now()
    const [slotIndex, evictedCapability] = await this.acquireSlot()
    await this.cfApi.updateSlotCode(slotIndex, code)
    await this.kv.setSlot(slotIndex, { capability, status: 'active' })
    await this.kv.setRoute(capability, { slot: slotIndex })
    await this.kv.setCode(capability, code)
    await this.kv.setMeta(capability, { type, ttl, created_at: now, bindings, description, tags, examples, schema })
    await this.kv.setLru(capability, { last_access: now, access_count: 0, deployed: true })
    try {
      const text = EmbeddingService.buildCapabilityText({ name: capability, description, tags, examples })
      await this.kv.setEmbedding(capability, await this.embeddingService.embed(text))
    } catch (e) { console.error('[sigil] embedding error:', e) }
    const url = this.config.GATEWAY_URL + '/run/' + capability
    const result: DeployResult = { capability, url, cold_start: false }
    if (type === 'ephemeral' && ttl !== undefined) result.expires_at = new Date(now + ttl * 1000).toISOString()
    if (evictedCapability) result.evicted = evictedCapability
    return result
  }

  async invoke(capabilityName: string, request: Request): Promise<Response> {
    const lru = await this.kv.getLru(capabilityName)
    if (!lru) {
      const code = await this.kv.getCode(capabilityName)
      if (!code) return new Response(JSON.stringify({ error: 'Capability not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      return this.pageInAndInvoke(capabilityName, code, request, true)
    }
    const route = await this.kv.getRoute(capabilityName)
    if (!route) {
      const code = await this.kv.getCode(capabilityName)
      if (!code) return new Response(JSON.stringify({ error: 'Capability code not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      return this.pageInAndInvoke(capabilityName, code, request, true)
    }
    const isColdStart = !lru.deployed
    await this.kv.setLru(capabilityName, { ...lru, last_access: Date.now(), access_count: lru.access_count + 1, deployed: true })
    const response = await this.cfApi.invoke(route.slot, request)
    if (isColdStart) {
      const h = new Headers(response.headers); h.set('X-Sigil-Cold-Start', 'true')
      return new Response(response.body, { status: response.status, headers: h })
    }
    return response
  }

  private async pageInAndInvoke(capabilityName: string, code: string, request: Request, isColdStart: boolean): Promise<Response> {
    const [slotIndex] = await this.acquireSlot()
    await this.cfApi.updateSlotCode(slotIndex, code)
    await this.kv.setSlot(slotIndex, { capability: capabilityName, status: 'active' })
    await this.kv.setRoute(capabilityName, { slot: slotIndex })
    const existingLru = await this.kv.getLru(capabilityName)
    await this.kv.setLru(capabilityName, { last_access: Date.now(), access_count: (existingLru?.access_count ?? 0) + 1, deployed: true })
    const response = await this.cfApi.invoke(slotIndex, request)
    if (isColdStart) {
      const h = new Headers(response.headers); h.set('X-Sigil-Cold-Start', 'true')
      return new Response(response.body, { status: response.status, headers: h })
    }
    return response
  }

  async remove(capabilityName: string): Promise<void> {
    const route = await this.kv.getRoute(capabilityName)
    if (route) {
      await this.cfApi.updateSlotCode(route.slot, IDLE_WORKER_CODE)
      await this.kv.setSlot(route.slot, { capability: null, status: 'free' })
    }
    await this.kv.deleteCode(capabilityName)
    await this.kv.deleteMeta(capabilityName)
    await this.kv.deleteLru(capabilityName)
    await this.kv.deleteRoute(capabilityName)
    await this.kv.deleteEmbedding(capabilityName)
  }

  async query(params: QueryParams): Promise<QueryResult> {
    const { q, mode: rawMode, limit: rawLimit, cursor } = params
    const mode = rawMode ?? (q ? 'find' : 'explore')
    const limit = rawLimit ?? (mode === 'find' ? 3 : 20)
    const caps = await this.kv.listCapabilities()
    if (!q) {
      const allCaps: Capability[] = []
      for (const cap of caps) {
        const meta = await this.kv.getMeta(cap); const lru = await this.kv.getLru(cap)
        if (!meta || !lru) continue
        const c: Capability = { capability: cap, type: meta.type, deployed: lru.deployed, last_access: lru.last_access, access_count: lru.access_count, created_at: meta.created_at, description: meta.description, tags: meta.tags, examples: meta.examples }
        if (meta.ttl !== undefined) { c.ttl = meta.ttl; c.expires_at = new Date(meta.created_at + meta.ttl * 1000).toISOString() }
        allCaps.push(c)
      }
      const sorted = allCaps.sort((a, b) => b.created_at - a.created_at)
      const items: QueryItem[] = sorted.map(c => ({ capability: c.capability, description: c.description, type: c.type, score: 1.0 }))
      const offset = cursor ? parseInt(cursor, 10) : 0
      return { total: items.length, items: items.slice(offset, offset + limit) }
    }
    const queryVec = await this.embeddingService.embedQuery(q)
    const embCands: Array<{ capability: string; vector: number[]; meta: any; lru: any }> = []
    const fbCands: Capability[] = []
    for (const cap of caps) {
      const vector = await this.kv.getEmbedding(cap); const meta = await this.kv.getMeta(cap); const lru = await this.kv.getLru(cap)
      if (!meta || !lru) continue
      if (vector) embCands.push({ capability: cap, vector, meta, lru })
      else fbCands.push({ capability: cap, type: meta.type, deployed: lru.deployed, last_access: lru.last_access, access_count: lru.access_count, created_at: meta.created_at, description: meta.description, tags: meta.tags, examples: meta.examples, schema: meta.schema })
    }
    const qLower = q.toLowerCase()
    const fbItems: QueryItem[] = fbCands.filter(c => c.capability.toLowerCase().includes(qLower) || c.description?.toLowerCase().includes(qLower) || c.tags?.some(t => t.toLowerCase().includes(qLower))).map(c => ({ capability: c.capability, description: c.description, tags: c.tags, examples: c.examples, type: c.type, deployed: c.deployed, access_count: c.access_count, score: 0.5, schema: c.schema }))
    if ((mode === 'find' && q) || mode === 'find') {
      const scored = embCands.map(c => ({ ...c, score: cosineSimilarity(queryVec, c.vector) })).filter(c => c.score > 0.3).sort((a, b) => b.score - a.score).slice(0, limit)
      const embItems: QueryItem[] = scored.map(c => ({ capability: c.capability, description: c.meta.description, tags: c.meta.tags, examples: c.meta.examples, type: c.meta.type, deployed: c.lru.deployed, access_count: c.lru.access_count, score: Math.round(c.score * 1000) / 1000, schema: c.meta.schema }))
      const embCaps = new Set(embItems.map(i => i.capability))
      const items = [...embItems, ...fbItems.filter(i => !embCaps.has(i.capability))].sort((a, b) => b.score - a.score).slice(0, limit)
      const offset = cursor ? parseInt(cursor, 10) : 0
      return { total: items.length, items: items.slice(offset, offset + limit) }
    }
    const results = mmrSelect(queryVec, embCands, limit, 0.5)
    const embItems: QueryItem[] = results.filter(r => r.score > 0.2).map(r => ({ capability: r.capability, description: r.meta.description, type: r.meta.type, score: Math.round(r.score * 1000) / 1000 }))
    const embCaps = new Set(embItems.map(i => i.capability))
    const items = [...embItems, ...fbItems.filter(i => !embCaps.has(i.capability)).map(({ capability, description, type, score }) => ({ capability, description, type, score }))].sort((a, b) => b.score - a.score).slice(0, limit)
    const offset = cursor ? parseInt(cursor, 10) : 0
    return { total: items.length, items: items.slice(offset, offset + limit) }
  }

  async inspect(capabilityName: string): Promise<Capability | null> {
    const meta = await this.kv.getMeta(capabilityName); const lru = await this.kv.getLru(capabilityName)
    if (!meta || !lru) return null
    const c: Capability = { capability: capabilityName, type: meta.type, deployed: lru.deployed, last_access: lru.last_access, access_count: lru.access_count, created_at: meta.created_at }
    if (meta.ttl !== undefined) { c.ttl = meta.ttl; c.expires_at = new Date(meta.created_at + meta.ttl * 1000).toISOString() }
    return c
  }

  async status(): Promise<BackendStatus> {
    let usedSlots = 0
    for (let i = 0; i < this.config.MAX_SLOTS; i++) { const s = await this.kv.getSlot(i); if (s?.status === 'active') usedSlots++ }
    return { backend: 'worker-pool', total_slots: this.config.MAX_SLOTS, used_slots: usedSlots, lru_enabled: true, eviction_count: await this.kv.getEvictionCount() }
  }
}
