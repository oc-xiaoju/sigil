import type { SigilBackend } from './backend/types.js'
import { AuthModule, AuthError, DeployCooldownError } from './auth.js'
import { KvStore } from './kv.js'
import { PageRateLimitError } from './lru.js'
import { generateWorkerCode } from './codegen.js'
import type { InputSchema } from './codegen.js'

export interface RouterEnv {
  SIGIL_KV: KVNamespace
  backend: SigilBackend
  auth: AuthModule
  kv: KvStore
}

export async function handleRequest(request: Request, env: RouterEnv): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  // GET /_health
  if (method === 'GET' && path === '/_health') {
    return handleHealth(env)
  }

  // POST /_api/deploy
  if (method === 'POST' && path === '/_api/deploy') {
    return handleDeploy(request, env)
  }

  // DELETE /_api/remove
  if (method === 'DELETE' && path === '/_api/remove') {
    return handleRemove(request, env)
  }

  // GET /_api/query — public, no auth
  if (method === 'GET' && path === '/_api/query') {
    return handleQuery(request, env)
  }

  // GET /_api/inspect/{capability}
  const inspectMatch = path.match(/^\/_api\/inspect\/(.+)$/)
  if (method === 'GET' && inspectMatch) {
    const capability = inspectMatch[1]!
    return handleInspect(capability, env)
  }

  // GET /run/{capability} — invoke (no auth required)
  const runMatch = path.match(/^\/run\/([^/]+)$/)
  if (runMatch) {
    const capability = runMatch[1]!
    return handleInvoke(capability, request, env, url)
  }

  return jsonError(404, 'Not found')
}

async function handleHealth(env: RouterEnv): Promise<Response> {
  const status = await env.backend.status()
  return jsonOk(status)
}

async function handleDeploy(request: Request, env: RouterEnv): Promise<Response> {
  try {
    const authHeader = request.headers.get('Authorization')
    await env.auth.validateToken(authHeader)

    const body = await request.json() as {
      name: string | null
      code?: string
      schema?: InputSchema
      execute?: string
      type: 'persistent' | 'normal' | 'ephemeral'
      ttl?: number
      bindings?: string[]
      description?: string
      tags?: string[]
      examples?: string[]
    }

    // Route validation
    if (body.code && (body.schema || body.execute)) {
      return jsonError(400, 'Cannot specify both code and schema/execute')
    }
    if (!body.code && !body.execute) {
      return jsonError(400, 'Must specify either code or schema+execute')
    }

    let code: string
    let schema: InputSchema | undefined

    if (body.code) {
      // 模式 A：直接部署
      code = body.code
    } else {
      // 模式 B：schema + execute
      if (!body.execute) {
        return jsonError(400, 'execute is required when using schema mode')
      }
      schema = body.schema || { type: 'object', properties: {} }
      code = generateWorkerCode(schema, body.execute)
    }

    // Check deploy cooldown
    await env.auth.checkDeployCooldown()

    const result = await env.backend.deploy({
      name: body.name,
      code,
      schema,
      type: body.type,
      ttl: body.ttl,
      bindings: body.bindings,
      description: body.description,
      tags: body.tags,
      examples: body.examples,
    })

    // Set cooldown after successful deploy
    await env.auth.setDeployCooldown()

    return jsonOk(result, 201)
  } catch (e) {
    if (e instanceof AuthError) {
      return jsonError(e.status, e.message)
    }
    if (e instanceof DeployCooldownError) {
      return jsonError(429, 'Deploy cooldown active', { retry_after: e.retry_after })
    }
    throw e
  }
}

async function handleRemove(request: Request, env: RouterEnv): Promise<Response> {
  try {
    const authHeader = request.headers.get('Authorization')
    await env.auth.validateToken(authHeader)

    const body = await request.json() as { capability: string }
    const capability = body.capability

    await env.backend.remove(capability)
    return jsonOk({ removed: capability })
  } catch (e) {
    if (e instanceof AuthError) {
      return jsonError(e.status, e.message)
    }
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

  const result = await env.backend.query({ q, mode, limit, cursor })
  return jsonOk(result)
}

async function handleInspect(capability: string, env: RouterEnv): Promise<Response> {
  const result = await env.backend.inspect(capability)
  if (!result) {
    return jsonError(404, 'Capability not found')
  }
  return jsonOk(result)
}

async function handleInvoke(
  capability: string,
  request: Request,
  env: RouterEnv,
  url: URL,
): Promise<Response> {
  try {
    // CF Workers cannot fetch() other workers on the same .workers.dev zone.
    // We resolve the sub-worker URL and redirect the client instead.
    const resolved = await env.backend.resolveInvoke(capability, request)

    if ('error' in resolved) {
      return jsonError(resolved.status, resolved.error)
    }

    // Build target URL: sub-worker subdomain + query params from original request
    const targetUrl = `https://${resolved.subdomain}/${url.search}`

    // Check if client wants a redirect or JSON pointer
    const accept = request.headers.get('Accept') || ''
    if (accept.includes('application/json') && !accept.includes('text/html')) {
      // JSON-aware client: return invoke URL for the client to call directly
      return jsonOk({
        url: targetUrl,
        capability,
        cold_start: resolved.cold_start,
      })
    }

    // Default: 302 redirect to the sub-worker
    const headers = new Headers({ Location: targetUrl })
    if (resolved.cold_start) {
      headers.set('X-Sigil-Cold-Start', 'true')
    }
    return new Response(null, { status: 302, headers })
  } catch (e) {
    if (e instanceof PageRateLimitError) {
      return jsonError(503, 'Page rate limit exceeded', { retry_after: e.retry_after })
    }
    throw e
  }
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function jsonError(status: number, message: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
