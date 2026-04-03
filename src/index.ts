import { WorkerPool } from './backend/worker-pool.js'
import { AuthModule } from './auth.js'
import { KvStore } from './kv.js'
import { handleRequest } from './router.js'
import { EmbeddingService } from './embedding.js'

export interface Env {
  SIGIL_KV: KVNamespace
  AI: any       // Cloudflare Workers AI binding
  LOADER: any   // Dynamic Workers loader binding
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const kv = new KvStore(env.SIGIL_KV)
    const embeddingService = new EmbeddingService(env.AI, env.SIGIL_KV)
    const backend = new WorkerPool(env.SIGIL_KV, env.LOADER, embeddingService)
    const auth = new AuthModule(kv)

    try {
      return await handleRequest(request, { SIGIL_KV: env.SIGIL_KV, backend, auth, kv })
    } catch (e) {
      console.error('[sigil] unhandled error:', e)
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  },
}
