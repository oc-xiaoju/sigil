// KV key prefixes and data types

export interface KvCodeValue {
  code: string
}

export interface KvMetaValue {
  type: 'persistent' | 'normal' | 'ephemeral'
  ttl?: number
  created_at: number
  bindings?: string[]
}

export interface KvLruValue {
  last_access: number
  access_count: number
  deployed: boolean
}

export interface KvRouteValue {
  worker_name: string
  subdomain: string
}

export interface KvAuthValue {
  token: string
  deploy_cooldown_until?: number
}

export interface KvPageRateValue {
  count: number
  window_start: number
}

export class KvStore {
  private kv: KVNamespace

  constructor(kv: KVNamespace) {
    this.kv = kv
  }

  // code:{capability}
  async getCode(capability: string): Promise<string | null> {
    const v = await this.kv.get(`code:${capability}`, 'json') as KvCodeValue | null
    return v?.code ?? null
  }

  async setCode(capability: string, code: string): Promise<void> {
    await this.kv.put(`code:${capability}`, JSON.stringify({ code }))
  }

  async deleteCode(capability: string): Promise<void> {
    await this.kv.delete(`code:${capability}`)
  }

  // meta:{capability}
  async getMeta(capability: string): Promise<KvMetaValue | null> {
    return await this.kv.get(`meta:${capability}`, 'json') as KvMetaValue | null
  }

  async setMeta(capability: string, meta: KvMetaValue): Promise<void> {
    await this.kv.put(`meta:${capability}`, JSON.stringify(meta))
  }

  async deleteMeta(capability: string): Promise<void> {
    await this.kv.delete(`meta:${capability}`)
  }

  // lru:{capability}
  async getLru(capability: string): Promise<KvLruValue | null> {
    return await this.kv.get(`lru:${capability}`, 'json') as KvLruValue | null
  }

  async setLru(capability: string, lru: KvLruValue): Promise<void> {
    await this.kv.put(`lru:${capability}`, JSON.stringify(lru))
  }

  async deleteLru(capability: string): Promise<void> {
    await this.kv.delete(`lru:${capability}`)
  }

  // route:{capability}
  async getRoute(capability: string): Promise<KvRouteValue | null> {
    return await this.kv.get(`route:${capability}`, 'json') as KvRouteValue | null
  }

  async setRoute(capability: string, route: KvRouteValue): Promise<void> {
    await this.kv.put(`route:${capability}`, JSON.stringify(route))
  }

  async deleteRoute(capability: string): Promise<void> {
    await this.kv.delete(`route:${capability}`)
  }

  // auth:deploy-token — single unified token
  async getDeployToken(): Promise<KvAuthValue | null> {
    return await this.kv.get('auth:deploy-token', 'json') as KvAuthValue | null
  }

  async setDeployToken(auth: KvAuthValue): Promise<void> {
    await this.kv.put('auth:deploy-token', JSON.stringify(auth))
  }

  // stats:eviction_count
  async getEvictionCount(): Promise<number> {
    const v = await this.kv.get('stats:eviction_count', 'json') as { count: number } | null
    return v?.count ?? 0
  }

  async incrementEvictionCount(): Promise<number> {
    const current = await this.getEvictionCount()
    const next = current + 1
    await this.kv.put('stats:eviction_count', JSON.stringify({ count: next }))
    return next
  }

  // stats:page_rate
  async getPageRate(): Promise<KvPageRateValue> {
    const v = await this.kv.get('stats:page_rate', 'json') as KvPageRateValue | null
    return v ?? { count: 0, window_start: Date.now() }
  }

  async setPageRate(rate: KvPageRateValue): Promise<void> {
    await this.kv.put('stats:page_rate', JSON.stringify(rate))
  }

  // stats:last_deploy_time — global deploy cooldown
  async getLastDeployTime(): Promise<number> {
    const v = await this.kv.get('stats:last_deploy_time', 'json') as { time: number } | null
    return v?.time ?? 0
  }

  async setLastDeployTime(time: number): Promise<void> {
    await this.kv.put('stats:last_deploy_time', JSON.stringify({ time }))
  }

  // List all capabilities by prefix scanning
  async listCapabilities(): Promise<string[]> {
    const list = await this.kv.list({ prefix: 'lru:' })
    return list.keys.map(k => k.name.slice('lru:'.length))
  }
}
