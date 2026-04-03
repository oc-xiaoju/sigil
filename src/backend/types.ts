import type { InputSchema } from '../codegen.js'

export interface DeployParams {
  name: string | null       // null = 自动生成 t-{hash}
  code?: string             // 模式 A：完整 Worker 代码
  schema?: InputSchema      // 模式 B：输入 schema
  execute?: string          // 模式 B：函数体
  type: 'persistent' | 'normal' | 'ephemeral'
  ttl?: number              // 秒，仅 ephemeral
  bindings?: string[]
  description?: string      // 一句话描述
  tags?: string[]           // 标签
  examples?: string[]       // 用法示例
}

export interface DeployResult {
  capability: string        // 直接就是 name，如 "ping"
  url: string
  expires_at?: string
  cold_start: boolean
  evicted?: string
}

export interface Capability {
  capability: string        // 直接就是 name，如 "ping"
  type: 'persistent' | 'normal' | 'ephemeral'
  deployed: boolean
  last_access: number
  access_count: number
  created_at: number
  ttl?: number
  expires_at?: string
  description?: string
  tags?: string[]
  examples?: string[]
  schema?: InputSchema      // 新增：find 模式返回，让 Agent 知道怎么调用
}

export interface QueryParams {
  q?: string
  mode?: 'find' | 'explore'
  limit?: number
  cursor?: string
}

export interface QueryItem {
  capability: string
  description?: string
  tags?: string[]
  examples?: string[]
  type: 'persistent' | 'normal' | 'ephemeral'
  deployed?: boolean
  access_count?: number
  score: number
  schema?: InputSchema      // 新增：find 模式返回
}

export interface QueryResult {
  total: number
  items: QueryItem[]
}

export interface BackendStatus {
  backend: 'worker-pool' | 'platform'
  total_slots: number
  used_slots: number
  lru_enabled: boolean
  eviction_count: number
}

export interface ResolveInvokeResult {
  subdomain: string         // e.g. "s-greet.shazhou.workers.dev"
  cold_start: boolean
}

export interface ResolveInvokeError {
  error: string
  status: number
}

export interface SigilBackend {
  deploy(params: DeployParams): Promise<DeployResult>
  invoke(name: string, request: Request): Promise<Response>
  resolveInvoke(name: string, request: Request): Promise<ResolveInvokeResult | ResolveInvokeError>
  remove(name: string): Promise<void>
  query(params: QueryParams): Promise<QueryResult>
  inspect(name: string): Promise<Capability | null>
  status(): Promise<BackendStatus>
}
