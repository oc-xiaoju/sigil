export const CONFIG = {
  MAX_SLOTS: 10,           // 测试用小值，生产 ~400
  MAX_AGENTS: 8,
  DEPLOY_COOLDOWN_MS: 5000,
  PAGE_RATE_LIMIT: 10,     // 次/分钟
  PAGE_RATE_WINDOW_MS: 60000,
  HASH_LENGTH: 6,
  WORKER_PREFIX: 's-',
  SUBDOMAIN_SUFFIX: '.shazhou.workers.dev',
  GATEWAY_URL: 'https://sigil.shazhou.workers.dev',
} as const
