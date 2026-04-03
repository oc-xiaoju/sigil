import { WorkerPool } from './backend/worker-pool.js'
import { AuthModule } from './auth.js'
import { KvStore } from './kv.js'
import { handleRequest } from './router.js'
import { createCfApi } from './cf-api.js'

export interface Env {
  SIGIL_KV: KVNamespace
  CF_API_TOKEN: string  // Worker Secret
  CF_ACCOUNT_ID: string // Worker Secret
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const kv = new KvStore(env.SIGIL_KV)
    const cfApi = createCfApi(env.CF_ACCOUNT_ID, env.CF_API_TOKEN)
    const backend = new WorkerPool(env.SIGIL_KV, cfApi)
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
