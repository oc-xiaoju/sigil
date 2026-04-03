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
   * Throws AuthError on failure.
   */
  async validateToken(authHeader: string | null): Promise<void> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthError(401, 'Missing or invalid Authorization header')
    }

    const token = authHeader.slice('Bearer '.length).trim()
    if (!token) {
      throw new AuthError(401, 'Empty token')
    }

    const auth = await this.kv.getDeployToken()
    if (!auth || auth.token !== token) {
      throw new AuthError(401, 'Invalid token')
    }
  }

  /**
   * Check global deploy cooldown. Throws DeployCooldownError if active.
   */
  async checkDeployCooldown(): Promise<void> {
    const lastDeploy = await this.kv.getLastDeployTime()
    if (!lastDeploy) return

    const now = Date.now()
    const cooldownUntil = lastDeploy + this.config.DEPLOY_COOLDOWN_MS
    if (cooldownUntil > now) {
      const retry_after = Math.ceil((cooldownUntil - now) / 1000)
      throw new DeployCooldownError(retry_after)
    }
  }

  /**
   * Set global deploy cooldown timestamp.
   */
  async setDeployCooldown(): Promise<void> {
    await this.kv.setLastDeployTime(Date.now())
  }

  /**
   * Set deploy token (used in tests).
   */
  async setToken(token: string): Promise<void> {
    await this.kv.setDeployToken({ token })
  }
}
