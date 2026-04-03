import { KvStore } from './kv.js'
import { CONFIG } from './config.js'

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export class DeployCooldownError extends Error {
  constructor(public readonly retry_after: number) {
    super('Deploy cooldown active')
    this.name = 'DeployCooldownError'
  }
}

export class AuthModule {
  constructor(
    private kv: KvStore,
    private config = CONFIG,
  ) {}

  /**
   * Validate Bearer token from Authorization header.
   * Returns agent name on success, throws AuthError on failure.
   */
  async validateToken(authHeader: string | null): Promise<string> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthError(401, 'Missing or invalid Authorization header')
    }

    const token = authHeader.slice('Bearer '.length).trim()
    if (!token) {
      throw new AuthError(401, 'Empty token')
    }

    // Scan all agents to find matching token
    const agents = await this.kv.listAgents()
    for (const agent of agents) {
      const auth = await this.kv.getAuth(agent)
      if (auth?.token === token) {
        return agent
      }
    }

    throw new AuthError(401, 'Invalid token')
  }

  /**
   * Check that authenticated agent can operate on target agent's namespace.
   */
  checkAgentAccess(authenticatedAgent: string, targetAgent: string): void {
    if (authenticatedAgent !== targetAgent) {
      throw new AuthError(403, `Agent ${authenticatedAgent} cannot access ${targetAgent}'s namespace`)
    }
  }

  /**
   * Check deploy cooldown for agent. Throws DeployCooldownError if active.
   */
  async checkDeployCooldown(agent: string): Promise<void> {
    const auth = await this.kv.getAuth(agent)
    if (!auth) return

    const now = Date.now()
    if (auth.deploy_cooldown_until && auth.deploy_cooldown_until > now) {
      const retry_after = Math.ceil((auth.deploy_cooldown_until - now) / 1000)
      throw new DeployCooldownError(retry_after)
    }
  }

  /**
   * Set deploy cooldown for agent.
   */
  async setDeployCooldown(agent: string): Promise<void> {
    const auth = await this.kv.getAuth(agent)
    if (!auth) return

    const until = Date.now() + this.config.DEPLOY_COOLDOWN_MS
    await this.kv.setAuth(agent, { ...auth, deploy_cooldown_until: until })
  }

  /**
   * Register a new agent with a token (used in tests).
   */
  async registerAgent(agent: string, token: string): Promise<void> {
    await this.kv.setAuth(agent, { token })
  }
}
