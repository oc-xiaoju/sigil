import type { Capability, QueryItem } from './backend/types.js'

/**
 * Phase 1 relevance scoring.
 * Returns a score in [0, 1.0].
 */
export function scoreCapability(capability: Capability, query: string): number {
  const q = query.toLowerCase()
  let s = 0

  // Name exact match
  if (capability.capability.toLowerCase() === q) {
    s += 1.0
  } else if (capability.capability.toLowerCase().includes(q)) {
    // Name contains
    s += 0.6
  }

  // Description contains
  if (capability.description?.toLowerCase().includes(q)) {
    s += 0.3
  }

  // Tag match (any tag hits)
  if (capability.tags?.some(t => t.toLowerCase().includes(q))) {
    s += 0.4
  }

  return Math.min(s, 1.0)
}

/**
 * Apply explore dedup: for capabilities sharing a tag, keep the first
 * highest-scored one and apply a 0.3 penalty to the rest.
 * Input items should already be sorted by score descending.
 */
export function applyExploreDedup(items: QueryItem[]): QueryItem[] {
  // Track which capability is the champion for each tag (first-seen wins on tie)
  const championByTag = new Map<string, string>()

  for (const item of items) {
    for (const tag of item.tags ?? []) {
      if (!championByTag.has(tag)) {
        championByTag.set(tag, item.capability)
      }
    }
  }

  // Penalise items that are not the tag champion for any of their tags
  return items.map(item => {
    const tags = item.tags ?? []
    if (tags.length === 0) return item

    const isChampion = tags.some(tag => championByTag.get(tag) === item.capability)
    if (isChampion) return item

    return { ...item, score: item.score * 0.3 }
  })
}
