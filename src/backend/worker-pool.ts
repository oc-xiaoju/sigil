import type { SigilBackend, DeployParams, DeployResult, Capability, BackendStatus, QueryParams, QueryResult, QueryItem } from './types.js'
import { KvStore } from '../kv.js'
import { LruScheduler, PageRateLimitError } from '../lru.js'
import { CONFIG } from '../config.js'
import { scoreCapability, applyExploreDedup } from '../scoring.js'

export interface CfApi {
  deployWorker(name: string, code: string): Promise<void>
  deleteWorker(name: string): Promise<void>
  getWorkerSubdomain(name: string): string
  invoke(workerName: string, request: Request): Promise<Response>
}

// In-flight page-in tracking to deduplicate concurrent requests
const inFlightPageIns = new Map<string, Promise<void>>()

export class WorkerPool implements SigilBackend {
  private kv: KvStore
  private lru: LruScheduler
  private config = CONFIG

  constructor(
    kv: KVNamespace,
    private cfApi: CfApi,
  ) {
    this.kv = new KvStore(kv)
    this.lru = new LruScheduler(this.kv)
  }

  private async generateHash(input: string): Promise<string> {
    // Use Web Crypto API (available in CF Workers and Node 15+)
    const encoder = new TextEncoder()
    const data = encoder.encode(input)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, this.config.HASH_LENGTH)
  }

  private getWorkerName(capability: string): string {
    return `${this.config.WORKER_PREFIX}${capability}`
  }

  async deploy(params: DeployParams): Promise<DeployResult> {
    const { name, code, type, ttl, bindings, description, tags, examples } = params

    // Determine capability name
    let capability: string
    if (name === null) {
      // Generate ephemeral name: t-{6hex}
      const hash = await this.generateHash(code + Date.now())
      capability = `t-${hash}`
    } else {
      capability = name
    }

    const workerName = this.getWorkerName(capability)
    const now = Date.now()

    // Check if we need to evict (loop handles KV eventual-consistency skew)
    let deployed = await this.lru.countDeployed()
    const evictedCapabilities: string[] = []

    while (deployed >= this.config.MAX_SLOTS) {
      const candidate = await this.lru.findEvictionCandidate()
      if (!candidate) break // nothing evictable

      evictedCapabilities.push(candidate.capability)
      const route = await this.kv.getRoute(candidate.capability)
      if (route) {
        await this.cfApi.deleteWorker(route.worker_name)
      }
      await this.kv.setLru(candidate.capability, {
        ...(await this.kv.getLru(candidate.capability))!,
        deployed: false,
      })
      await this.kv.incrementEvictionCount()

      deployed = await this.lru.countDeployed()
    }

    const evictedCapability = evictedCapabilities[0]

    // Deploy the worker
    await this.cfApi.deployWorker(workerName, code)
    const subdomain = this.cfApi.getWorkerSubdomain(workerName)

    // Write KV entries
    await this.kv.setCode(capability, code)
    await this.kv.setMeta(capability, {
      type,
      ttl,
      created_at: now,
      bindings,
      description,
      tags,
      examples,
    })
    await this.kv.setLru(capability, {
      last_access: now,
      access_count: 0,
      deployed: true,
    })
    await this.kv.setRoute(capability, {
      worker_name: workerName,
      subdomain,
    })

    const url = `${this.config.GATEWAY_URL}/run/${capability}`
    const result: DeployResult = {
      capability,
      url,
      cold_start: false,
    }

    if (type === 'ephemeral' && ttl !== undefined) {
      result.expires_at = new Date(now + ttl * 1000).toISOString()
    }

    if (evictedCapability) {
      result.evicted = evictedCapability
    }

    return result
  }

  async invoke(capabilityName: string, request: Request): Promise<Response> {
    const lru = await this.kv.getLru(capabilityName)

    if (!lru) {
      // Check if we have code (page-in scenario)
      const code = await this.kv.getCode(capabilityName)
      if (!code) {
        return new Response(JSON.stringify({ error: 'Capability not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Page in
      return await this.pageIn(capabilityName, code, request, true)
    }

    if (!lru.deployed) {
      // Need to page in
      const code = await this.kv.getCode(capabilityName)
      if (!code) {
        return new Response(JSON.stringify({ error: 'Capability not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return await this.pageIn(capabilityName, code, request, true)
    }

    // Warm hit — update LRU and invoke
    await this.kv.setLru(capabilityName, {
      ...lru,
      last_access: Date.now(),
      access_count: lru.access_count + 1,
    })

    const route = await this.kv.getRoute(capabilityName)
    if (!route) {
      return new Response(JSON.stringify({ error: 'Route not found' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return await this.cfApi.invoke(route.worker_name, request)
  }

  private async doPageIn(capability: string, code: string): Promise<void> {
    // Check rate limit BEFORE eviction/deployment
    await this.lru.checkPageRate()

    // Evict until we have a free slot (loop handles KV eventual-consistency skew)
    let deployed = await this.lru.countDeployed()
    while (deployed >= this.config.MAX_SLOTS) {
      const candidate = await this.lru.findEvictionCandidate()
      if (!candidate) break // no evictable candidate — proceed anyway

      const route = await this.kv.getRoute(candidate.capability)
      if (route) {
        await this.cfApi.deleteWorker(route.worker_name)
      }
      const existingLru = await this.kv.getLru(candidate.capability)
      if (existingLru) {
        await this.kv.setLru(candidate.capability, {
          ...existingLru,
          deployed: false,
        })
      }
      await this.kv.incrementEvictionCount()

      // Re-count after eviction so the while condition is accurate
      deployed = await this.lru.countDeployed()
    }

    const workerName = this.getWorkerName(capability)
    await this.cfApi.deployWorker(workerName, code)
    const subdomain = this.cfApi.getWorkerSubdomain(workerName)

    const now = Date.now()
    await this.kv.setRoute(capability, { worker_name: workerName, subdomain })
    await this.kv.setLru(capability, {
      last_access: now,
      access_count: 1,
      deployed: true,
    })
  }

  private async pageIn(
    capability: string,
    code: string,
    request: Request,
    isColdStart: boolean,
  ): Promise<Response> {
    // Deduplicate concurrent page-ins
    const existing = inFlightPageIns.get(capability)
    if (existing) {
      // Wait for in-flight page-in to complete (may throw)
      await existing
    } else {
      // We are the "primary" page-in for this capability
      const primaryPageIn = this.doPageIn(capability, code)
      inFlightPageIns.set(capability, primaryPageIn)
      try {
        await primaryPageIn
      } finally {
        inFlightPageIns.delete(capability)
      }
    }

    // Re-check: after page-in we should have route
    const lru = await this.kv.getLru(capability)
    if (!lru?.deployed) {
      return new Response(JSON.stringify({ error: 'Page-in failed' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const route = await this.kv.getRoute(capability)
    if (!route) {
      return new Response(JSON.stringify({ error: 'Route not found after page-in' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Update LRU
    await this.kv.setLru(capability, {
      ...lru,
      last_access: Date.now(),
      access_count: lru.access_count + 1,
    })

    const response = await this.cfApi.invoke(route.worker_name, request)

    // Add cold start header
    if (isColdStart) {
      const headers = new Headers(response.headers)
      headers.set('X-Sigil-Cold-Start', 'true')
      return new Response(response.body, {
        status: response.status,
        headers,
      })
    }

    return response
  }

  async remove(capabilityName: string): Promise<void> {
    const lru = await this.kv.getLru(capabilityName)

    if (lru?.deployed) {
      const route = await this.kv.getRoute(capabilityName)
      if (route) {
        await this.cfApi.deleteWorker(route.worker_name)
      }
    }

    await this.kv.deleteCode(capabilityName)
    await this.kv.deleteMeta(capabilityName)
    await this.kv.deleteLru(capabilityName)
    await this.kv.deleteRoute(capabilityName)
  }

  async query(params: QueryParams): Promise<QueryResult> {
    const { q, mode: rawMode, limit: rawLimit, cursor } = params

    // Determine effective mode
    const mode = rawMode ?? (q ? 'find' : 'explore')
    const defaultLimit = mode === 'find' ? 3 : 20
    const limit = rawLimit ?? defaultLimit

    // Fetch all capabilities
    const caps = await this.kv.listCapabilities()
    const allCapabilities: Capability[] = []

    for (const cap of caps) {
      const meta = await this.kv.getMeta(cap)
      const lru = await this.kv.getLru(cap)
      if (!meta || !lru) continue

      const capability: Capability = {
        capability: cap,
        type: meta.type,
        deployed: lru.deployed,
        last_access: lru.last_access,
        access_count: lru.access_count,
        created_at: meta.created_at,
        description: meta.description,
        tags: meta.tags,
        examples: meta.examples,
      }

      if (meta.ttl !== undefined) {
        capability.ttl = meta.ttl
        capability.expires_at = new Date(meta.created_at + meta.ttl * 1000).toISOString()
      }

      allCapabilities.push(capability)
    }

    // If mode=find but no q → treat as explore
    const effectiveMode = (mode === 'find' && !q) ? 'explore' : mode

    let items: QueryItem[]

    if (!q) {
      // No query — explore mode: sort by created_at descending, return summaries
      const sorted = [...allCapabilities].sort((a, b) => b.created_at - a.created_at)
      items = sorted.map(cap => ({
        capability: cap.capability,
        description: cap.description,
        type: cap.type,
        score: 1.0,
      }))
    } else {
      // Score and filter
      const scored = allCapabilities
        .map(cap => ({ cap, score: scoreCapability(cap, q) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)

      if (effectiveMode === 'find') {
        items = scored.map(({ cap, score }) => ({
          capability: cap.capability,
          description: cap.description,
          tags: cap.tags,
          examples: cap.examples,
          type: cap.type,
          deployed: cap.deployed,
          access_count: cap.access_count,
          score,
        }))
      } else {
        // explore: build summary items then apply dedup
        const summaryItems: QueryItem[] = scored.map(({ cap, score }) => ({
          capability: cap.capability,
          description: cap.description,
          tags: cap.tags,   // keep tags for dedup logic, stripped later
          type: cap.type,
          score,
        }))

        const deduped = applyExploreDedup(summaryItems)
          .sort((a, b) => b.score - a.score)

        // Strip tags/examples from explore output (only capability/description/type/score)
        items = deduped.map(({ capability, description, type, score }) => ({
          capability,
          description,
          type,
          score,
        }))
      }
    }

    // Apply cursor (offset-based paging)
    const offset = cursor ? parseInt(cursor, 10) : 0
    const total = items.length
    const paged = items.slice(offset, offset + limit)

    return { total, items: paged }
  }

  async inspect(capabilityName: string): Promise<Capability | null> {
    const meta = await this.kv.getMeta(capabilityName)
    const lru = await this.kv.getLru(capabilityName)
    if (!meta || !lru) return null

    const capability: Capability = {
      capability: capabilityName,
      type: meta.type,
      deployed: lru.deployed,
      last_access: lru.last_access,
      access_count: lru.access_count,
      created_at: meta.created_at,
    }

    if (meta.ttl !== undefined) {
      capability.ttl = meta.ttl
      capability.expires_at = new Date(meta.created_at + meta.ttl * 1000).toISOString()
    }

    return capability
  }

  async status(): Promise<BackendStatus> {
    const caps = await this.kv.listCapabilities()
    let usedSlots = 0

    for (const cap of caps) {
      const lru = await this.kv.getLru(cap)
      if (lru?.deployed) usedSlots++
    }

    const evictionCount = await this.kv.getEvictionCount()

    return {
      backend: 'worker-pool',
      total_slots: this.config.MAX_SLOTS,
      used_slots: Math.min(usedSlots, this.config.MAX_SLOTS),
      lru_enabled: true,
      eviction_count: evictionCount,
    }
  }
}
