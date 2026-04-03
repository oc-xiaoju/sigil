import type { SigilBackend } from './backend/types.js'
import { AuthModule, AuthError, DeployCooldownError } from './auth.js'
import { KvStore } from './kv.js'
import { PageRateLimitError } from './lru.js'

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

  // GET /_api/list
  if (method === 'GET' && path === '/_api/list') {
    return handleList(request, env)
  }

  // GET /_api/inspect/{capability}
  const inspectMatch = path.match(/^\/_api\/inspect\/(.+)$/)
  if (method === 'GET' && inspectMatch) {
    const capability = inspectMatch[1]!
    return handleInspect(capability, env)
  }

  // GET /{agent}/{capability} — invoke
  const invokeMatch = path.match(/^\/([^/]+)\/([^/]+)$/)
  if (invokeMatch) {
    const agent = invokeMatch[1]!
    const cap = invokeMatch[2]!
    return handleInvoke(agent, cap, request, env)
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
    const agent = await env.auth.validateToken(authHeader)

    const body = await request.json() as {
      agent: string
      name: string | null
      code: string
      type: 'persistent' | 'normal' | 'ephemeral'
      ttl?: number
      bindings?: string[]
    }

    // Check agent isolation
    env.auth.checkAgentAccess(agent, body.agent)

    // Check deploy cooldown
    await env.auth.checkDeployCooldown(agent)

    const result = await env.backend.deploy({
      agent: body.agent,
      name: body.name,
      code: body.code,
      type: body.type,
      ttl: body.ttl,
      bindings: body.bindings,
    })

    // Set cooldown after successful deploy
    await env.auth.setDeployCooldown(agent)

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
    const agent = await env.auth.validateToken(authHeader)

    const body = await request.json() as { capability: string }
    const capability = body.capability

    // Check agent owns this capability
    const agentPrefix = `${agent}--`
    if (!capability.startsWith(agentPrefix)) {
      return jsonError(403, `Agent ${agent} cannot remove ${capability}`)
    }

    await env.backend.remove(capability)
    return jsonOk({ removed: capability })
  } catch (e) {
    if (e instanceof AuthError) {
      return jsonError(e.status, e.message)
    }
    throw e
  }
}

async function handleList(request: Request, env: RouterEnv): Promise<Response> {
  try {
    const authHeader = request.headers.get('Authorization')
    const agent = await env.auth.validateToken(authHeader)
    const url = new URL(request.url)
    const filterAgent = url.searchParams.get('agent') ?? undefined

    // Agent can only list their own capabilities
    if (filterAgent && filterAgent !== agent) {
      return jsonError(403, `Agent ${agent} cannot list ${filterAgent}'s capabilities`)
    }

    const list = await env.backend.list(filterAgent ?? agent)
    return jsonOk({ capabilities: list })
  } catch (e) {
    if (e instanceof AuthError) {
      return jsonError(e.status, e.message)
    }
    throw e
  }
}

async function handleInspect(capability: string, env: RouterEnv): Promise<Response> {
  const result = await env.backend.inspect(capability)
  if (!result) {
    return jsonError(404, 'Capability not found')
  }
  return jsonOk(result)
}

async function handleInvoke(
  agent: string,
  capName: string,
  request: Request,
  env: RouterEnv,
): Promise<Response> {
  const capability = `${agent}--${capName}`
  try {
    return await env.backend.invoke(capability, request)
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
