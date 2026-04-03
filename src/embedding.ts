// Embedding service for semantic search

export class EmbeddingService {
  private ai: any  // Cloudflare AI binding
  private kv: KVNamespace
  private model = '@cf/baai/bge-base-en-v1.5'

  constructor(ai: any, kv: KVNamespace) {
    this.ai = ai
    this.kv = kv
  }

  // Build embedding text for a capability
  static buildCapabilityText(params: {
    name: string
    description?: string
    tags?: string[]
    examples?: string[]
  }): string {
    const parts = [params.name]
    if (params.description) parts.push(params.description)
    if (params.tags?.length) parts.push(`tags: ${params.tags.join(', ')}`)
    if (params.examples?.length) parts.push(`examples: ${params.examples.join('; ')}`)
    return parts.join('. ')
  }

  // Compute embedding (no cache, used at deploy time)
  async embed(text: string): Promise<number[]> {
    const result = await this.ai.run(this.model, { text: [text] })
    return result.data[0]
  }

  // Cached query embedding (1h TTL)
  async embedQuery(query: string): Promise<number[]> {
    const hash = await this.hashQuery(query)
    const cacheKey = `cache:embed:${hash}`

    // Check cache
    const cached = await this.kv.get(cacheKey, 'json') as { vector: number[]; ts: number } | null
    if (cached && Date.now() - cached.ts < 3_600_000) {
      return cached.vector
    }

    // Compute
    const vector = await this.embed(query)

    // Store with TTL
    await this.kv.put(cacheKey, JSON.stringify({ vector, ts: Date.now() }), {
      expirationTtl: 3600,
    })

    return vector
  }

  private async hashQuery(query: string): Promise<string> {
    const data = new TextEncoder().encode(query)
    const hash = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(hash)).slice(0, 6)
      .map(b => b.toString(16).padStart(2, '0')).join('')
  }
}

// Cosine similarity between two vectors
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}

// MMR (Maximal Marginal Relevance) for explore mode
export function mmrSelect(
  queryVec: number[],
  candidates: Array<{ capability: string; vector: number[]; meta: any }>,
  limit: number,
  lambda: number = 0.5,
): Array<{ capability: string; score: number; meta: any }> {
  const selected: Array<{ capability: string; vector: number[]; score: number; meta: any }> = []
  const remaining = [...candidates]

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]
      const relevance = cosineSimilarity(queryVec, cand.vector)

      // Max similarity to already selected
      let maxSim = 0
      for (const sel of selected) {
        const sim = cosineSimilarity(cand.vector, sel.vector)
        if (sim > maxSim) maxSim = sim
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim
      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    if (bestIdx === -1) break

    const chosen = remaining.splice(bestIdx, 1)[0]
    selected.push({
      ...chosen,
      score: cosineSimilarity(queryVec, chosen.vector),
    })
  }

  return selected.map(({ capability, score, meta }) => ({ capability, score, meta }))
}
