export const CONFIG = {
  MAX_SLOTS: 3,            // LRU 验证用，生产 ~400
  DEPLOY_COOLDOWN_MS: 5000,
  PAGE_RATE_LIMIT: 10,     // 次/分钟
  PAGE_RATE_WINDOW_MS: 60000,
  HASH_LENGTH: 8,
  GATEWAY_URL: 'https://sigil.shazhou.workers.dev',
} as const
