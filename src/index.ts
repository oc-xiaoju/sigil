import { WorkerPool, type CfApi } from './backend/worker-pool.js'
import { AuthModule } from './auth.js'
import { KvStore } from './kv.js'
import { handleRequest } from './router.js'
import { CONFIG } from './config.js'

export interface Env {
  SIGIL_KV: KVNamespace
}

const defaultCfApi: CfApi = {
  async deployWorker(name: string, _code: string): Promise<void> {
    // Production: use CF API to deploy
    console.log(`[sigil] deploy worker: ${name}`)
  },
  async deleteWorker(name: string): Promise<void> {
    console.log(`[sigil] delete worker: ${name}`)
  },
  getWorkerSubdomain(name: string): string {
    return `${name}${CONFIG.SUBDOMAIN_SUFFIX}`
  },
  async invoke(_workerName: string, request: Request): Promise<Response> {
    // Production: fetch from worker subdomain
    return new Response('Not implemented', { status: 501 })
  },
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const kv = new KvStore(env.SIGIL_KV)
    const backend = new WorkerPool(env.SIGIL_KV, defaultCfApi)
    const auth = new AuthModule(kv)

    return handleRequest(request, { SIGIL_KV: env.SIGIL_KV, backend, auth, kv })
  },
}
