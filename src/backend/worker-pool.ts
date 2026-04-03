import type { SigilBackend, DeployParams, DeployResult, Capability, BackendStatus } from './types.js'
import { KvStore } from '../kv.js'
import { LruScheduler, PageRateLimitError } from '../lru.js'
import { CONFIG } from '../config.js'

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
    return `${this.config.WORKER_PREFIX}${capability.replace('--', '-')}`
  }

  async deploy(params: DeployParams): Promise<DeployResult> {
    const { agent, name, code, type, ttl, bindings } = params

    // Determine capability name
    let capabilityName: string
    if (name === null) {
      // Generate ephemeral name: t-{6hex}
      const hash = await this.generateHash(code + Date.now())
      capabilityName = `t-${hash}`
    } else {
      capabilityName = name
    }

    const capability = `${agent}--${capabilityName}`
    const workerName = this.getWorkerName(capability)
    const now = Date.now()

    // Check if we need to evict
    const deployed = await this.lru.countDeployed()
    let evictedCapability: string | undefined

    if (deployed >= this.config.MAX_SLOTS) {
      const candidate = await this.lru.findEvictionCandidate()
      if (candidate) {
        evictedCapability = candidate.capability
        const route = await this.kv.getRoute(candidate.capability)
        if (route) {
          await this.cfApi.deleteWorker(route.worker_name)
        }
        await this.kv.setLru(candidate.capability, {
          ...(await this.kv.getLru(candidate.capability))!,
          deployed: false,
        })
        await this.kv.incrementEvictionCount()
      }
    }

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
      agent,
      name: capabilityName,
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

    const url = `${this.config.GATEWAY_URL}/${agent}/${capabilityName}`
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
    // Check rate limit
    await this.lru.checkPageRate()

    // Check if eviction needed
    const deployed = await this.lru.countDeployed()
    if (deployed >= this.config.MAX_SLOTS) {
      const candidate = await this.lru.findEvictionCandidate()
      if (candidate) {
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
      }
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

  async list(agent?: string): Promise<Capability[]> {
    const prefix = agent ? `${agent}--` : undefined
    const caps = await this.kv.listCapabilities(prefix)
    const result: Capability[] = []

    for (const cap of caps) {
      const meta = await this.kv.getMeta(cap)
      const lru = await this.kv.getLru(cap)
      if (!meta || !lru) continue

      const capability: Capability = {
        capability: cap,
        agent: meta.agent,
        name: meta.name,
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

      result.push(capability)
    }

    return result
  }

  async inspect(capabilityName: string): Promise<Capability | null> {
    const meta = await this.kv.getMeta(capabilityName)
    const lru = await this.kv.getLru(capabilityName)
    if (!meta || !lru) return null

    const capability: Capability = {
      capability: capabilityName,
      agent: meta.agent,
      name: meta.name,
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
    const agentSet = new Set<string>()

    for (const cap of caps) {
      const lru = await this.kv.getLru(cap)
      const meta = await this.kv.getMeta(cap)
      if (lru?.deployed) usedSlots++
      if (meta?.agent) agentSet.add(meta.agent)
    }

    const evictionCount = await this.kv.getEvictionCount()

    return {
      backend: 'worker-pool',
      total_slots: this.config.MAX_SLOTS,
      used_slots: usedSlots,
      agents: agentSet.size,
      lru_enabled: true,
      eviction_count: evictionCount,
    }
  }
}
