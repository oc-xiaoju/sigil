import type { SigilBackend } from './backend/types.js'
import type { CfApi } from './cf-api.js'
import { AuthModule, AuthError, DeployCooldownError } from './auth.js'
import { KvStore } from './kv.js'
import { generateWorkerCode } from './codegen.js'
import { CONFIG } from './config.js'
import type { InputSchema } from './codegen.js'

export interface RouterEnv {
  SIGIL_KV: KVNamespace
  backend: SigilBackend
  auth: AuthModule
  kv: KvStore
  cfApi?: CfApi
}

export async function handleRequest(request: Request, env: RouterEnv): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  if (method === 'GET' && path === '/_health') return handleHealth(env)
  if (method === 'POST' && path === '/_api/deploy') return handleDeploy(request, env)
  if (method === 'DELETE' && path === '/_api/remove') return handleRemove(request, env)
  if (method === 'GET' && path === '/_api/query') return handleQuery(request, env)
  if (method === 'POST' && path === '/_api/init-slots') return handleInitSlots(request, env)

  const inspectMatch = path.match(/^\/_api\/inspect\/(.+)$/)
  if (method === 'GET' && inspectMatch) return handleInspect(inspectMatch[1]!, env)

  const runMatch = path.match(/^\/run\/([^/]+)$/)
  if (runMatch) return handleInvoke(runMatch[1]!, request, env)

  return jsonError(404, 'Not found')
}

async function handleHealth(env: RouterEnv): Promise<Response> {
  return jsonOk(await env.backend.status())
}

async function handleDeploy(request: Request, env: RouterEnv): Promise<Response> {
  try {
    await env.auth.validateToken(request.headers.get('Authorization'))
    const body = await request.json() as {
      name: string | null; code?: string; schema?: InputSchema; execute?: string
      type: 'persistent' | 'normal' | 'ephemeral'; ttl?: number; bindings?: string[]
      description?: string; tags?: string[]; examples?: string[]
    }
    if (body.code && (body.schema || body.execute)) return jsonError(400, 'Cannot specify both code and schema/execute')
    if (!body.code && !body.execute) return jsonError(400, 'Must specify either code or schema+execute')
    let code: string
    let schema: InputSchema | undefined
    if (body.code) {
      code = body.code
    } else {
      if (!body.execute) return jsonError(400, 'execute is required when using schema mode')
      schema = body.schema || { type: 'object', properties: {} }
      code = generateWorkerCode(schema, body.execute)
    }
    await env.auth.checkDeployCooldown()
    const result = await env.backend.deploy({ name: body.name, code, schema, type: body.type, ttl: body.ttl, bindings: body.bindings, description: body.description, tags: body.tags, examples: body.examples })
    await env.auth.setDeployCooldown()
    return jsonOk(result, 201)
  } catch (e) {
    if (e instanceof AuthError) return jsonError(e.status, e.message)
    if (e instanceof DeployCooldownError) return jsonError(429, 'Deploy cooldown active', { retry_after: e.retry_after })
    throw e
  }
}

async function handleRemove(request: Request, env: RouterEnv): Promise<Response> {
  try {
    await env.auth.validateToken(request.headers.get('Authorization'))
    const body = await request.json() as { capability: string }
    await env.backend.remove(body.capability)
    return jsonOk({ removed: body.capability })
  } catch (e) {
    if (e instanceof AuthError) return jsonError(e.status, e.message)
    throw e
  }
}

async function handleQuery(request: Request, env: RouterEnv): Promise<Response> {
  const url = new URL(request.url)
  const q = url.searchParams.get('q') ?? undefined
  const modeRaw = url.searchParams.get('mode')
  const mode = (modeRaw === 'find' || modeRaw === 'explore') ? modeRaw : undefined
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined
  const cursor = url.searchParams.get('cursor') ?? undefined
  return jsonOk(await env.backend.query({ q, mode, limit, cursor }))
}

async function handleInspect(capability: string, env: RouterEnv): Promise<Response> {
  const result = await env.backend.inspect(capability)
  if (!result) return jsonError(404, 'Capability not found')
  return jsonOk(result)
}

async function handleInvoke(capability: string, request: Request, env: RouterEnv): Promise<Response> {
  return await env.backend.invoke(capability, request)
}

async function handleInitSlots(request: Request, env: RouterEnv): Promise<Response> {
  try {
    await env.auth.validateToken(request.headers.get('Authorization'))
    if (!env.cfApi) return jsonError(500, 'cfApi not available in this environment')
    const results: Array<{ slot: number; status: 'initialized' | 'skipped'; worker: string }> = []
    for (let i = 0; i < CONFIG.MAX_SLOTS; i++) {
      const existing = await env.kv.getSlot(i)
      if (existing !== null) {
        results.push({ slot: i, status: 'skipped', worker: CONFIG.SLOT_PREFIX + i })
        continue
      }
      await env.cfApi.initSlot(i)
      await env.kv.setSlot(i, { capability: null, status: 'free' })
      results.push({ slot: i, status: 'initialized', worker: CONFIG.SLOT_PREFIX + i })
    }
    return jsonOk({
      initialized: results.filter(r => r.status === 'initialized').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      slots: results,
    })
  } catch (e) {
    if (e instanceof AuthError) return jsonError(e.status, e.message)
    throw e
  }
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function jsonError(status: number, message: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), { status, headers: { 'Content-Type': 'application/json' } })
}
