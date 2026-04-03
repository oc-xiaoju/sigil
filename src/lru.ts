import { KvStore } from './kv.js'
import { CONFIG } from './config.js'

export type EvictionPriority = 'ephemeral_expired' | 'ephemeral' | 'normal' | 'persistent'

export interface LruCandidate {
  capability: string
  priority: EvictionPriority
  last_access: number
}

export class PageRateLimitError extends Error {
  constructor(public readonly retry_after: number) {
    super('Page rate limit exceeded')
    this.name = 'PageRateLimitError'
  }
}

export class LruScheduler {
  constructor(
    private kv: KvStore,
    private config = CONFIG,
  ) {}

  /**
   * Check and increment page rate. Returns retry_after (seconds) if rate limited.
   */
  async checkPageRate(): Promise<void> {
    const now = Date.now()
    const rate = await this.kv.getPageRate()

    // Reset window if expired
    if (now - rate.window_start >= this.config.PAGE_RATE_WINDOW_MS) {
      await this.kv.setPageRate({ count: 1, window_start: now })
      return
    }

    if (rate.count >= this.config.PAGE_RATE_LIMIT) {
      const retry_after = Math.ceil(
        (rate.window_start + this.config.PAGE_RATE_WINDOW_MS - now) / 1000
      )
      throw new PageRateLimitError(retry_after)
    }

    await this.kv.setPageRate({ count: rate.count + 1, window_start: rate.window_start })
  }

  /**
   * Count how many capabilities are currently deployed.
   */
  async countDeployed(): Promise<number> {
    const caps = await this.kv.listCapabilities()
    let count = 0
    for (const cap of caps) {
      const lru = await this.kv.getLru(cap)
      if (lru?.deployed) count++
    }
    return count
  }

  /**
   * Find the best eviction candidate (lowest priority + oldest access).
   * Returns null if no evictable candidate found.
   */
  async findEvictionCandidate(): Promise<LruCandidate | null> {
    const caps = await this.kv.listCapabilities()
    const candidates: LruCandidate[] = []

    for (const cap of caps) {
      const lru = await this.kv.getLru(cap)
      if (!lru?.deployed) continue

      const meta = await this.kv.getMeta(cap)
      if (!meta) continue

      let priority: EvictionPriority

      if (meta.type === 'ephemeral') {
        const isExpired = meta.ttl !== undefined
          && (meta.created_at + meta.ttl * 1000) < Date.now()
        priority = isExpired ? 'ephemeral_expired' : 'ephemeral'
      } else if (meta.type === 'normal') {
        priority = 'normal'
      } else {
        priority = 'persistent'
      }

      candidates.push({ capability: cap, priority, last_access: lru.last_access })
    }

    if (candidates.length === 0) return null

    const priorityOrder: Record<EvictionPriority, number> = {
      ephemeral_expired: 0,
      ephemeral: 1,
      normal: 2,
      persistent: 3,
    }

    candidates.sort((a, b) => {
      const pd = priorityOrder[a.priority] - priorityOrder[b.priority]
      if (pd !== 0) return pd
      return a.last_access - b.last_access
    })

    return candidates[0] ?? null
  }
}
