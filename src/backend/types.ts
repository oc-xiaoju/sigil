export interface DeployParams {
  agent: string
  name: string | null       // null = 自动生成 t-{hash}
  code: string
  type: 'persistent' | 'normal' | 'ephemeral'
  ttl?: number              // 秒，仅 ephemeral
  bindings?: string[]
}

export interface DeployResult {
  capability: string        // xiaoju--ping
  url: string
  expires_at?: string
  cold_start: boolean
  evicted?: string
}

export interface Capability {
  capability: string
  agent: string
  name: string
  type: 'persistent' | 'normal' | 'ephemeral'
  deployed: boolean
  last_access: number
  access_count: number
  created_at: number
  ttl?: number
  expires_at?: string
}

export interface BackendStatus {
  backend: 'worker-pool' | 'platform'
  total_slots: number
  used_slots: number
  agents: number
  lru_enabled: boolean
  eviction_count: number
}

export interface SigilBackend {
  deploy(params: DeployParams): Promise<DeployResult>
  invoke(name: string, request: Request): Promise<Response>
  remove(name: string): Promise<void>
  list(agent?: string): Promise<Capability[]>
  inspect(name: string): Promise<Capability | null>
  status(): Promise<BackendStatus>
}
