export const CONFIG = {
  MAX_SLOTS: 3,            // 预分配 slot 数量（物理页帧总数）
  DEPLOY_COOLDOWN_MS: 5000,
  PAGE_RATE_LIMIT: 10,     // 次/分钟
  PAGE_RATE_WINDOW_MS: 60000,
  HASH_LENGTH: 6,
  SLOT_PREFIX: 's-slot-',  // slot Worker 名前缀：s-slot-0, s-slot-1, ...
  SUBDOMAIN_SUFFIX: '.shazhou.workers.dev',
  GATEWAY_URL: 'https://sigil.shazhou.workers.dev',
} as const
