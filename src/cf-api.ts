import { CONFIG } from './config.js'
import type { CfApi } from './backend/worker-pool.js'

export function createCfApi(accountId: string, apiToken: string): CfApi {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`

  return {
    async deployWorker(name: string, code: string): Promise<void> {
      // CF API: PUT /accounts/{account_id}/workers/scripts/{script_name}
      // ESM format requires multipart form upload with metadata
      const metadata = JSON.stringify({
        main_module: 'worker.js',
        compatibility_date: '2026-04-03',
      })

      // Build multipart form body
      const formData = new FormData()
      formData.append('metadata', new Blob([metadata], { type: 'application/json' }))
      formData.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js')

      const resp = await fetch(`${baseUrl}/${name}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
        body: formData,
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`CF API deploy failed (${resp.status}): ${text}`)
      }

      // Enable workers.dev subdomain for the newly deployed Worker
      const subdomainResp = await fetch(`${baseUrl}/${name}/subdomain`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: true }),
      })
      if (!subdomainResp.ok) {
        console.warn(`[sigil] failed to enable subdomain for ${name}: ${subdomainResp.status}`)
      }
    },

    async deleteWorker(name: string): Promise<void> {
      // CF API: DELETE /accounts/{account_id}/workers/scripts/{script_name}
      const resp = await fetch(`${baseUrl}/${name}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
      })
      if (!resp.ok && resp.status !== 404) {
        const text = await resp.text()
        throw new Error(`CF API delete failed (${resp.status}): ${text}`)
      }
    },

    getWorkerSubdomain(name: string): string {
      return `${name}${CONFIG.SUBDOMAIN_SUFFIX}`
    },

    async invoke(workerName: string, request: Request): Promise<Response> {
      // 转发请求到 Worker 子域名
      const url = new URL(request.url)
      const targetUrl = `https://${workerName}${CONFIG.SUBDOMAIN_SUFFIX}${url.pathname}${url.search}`

      return fetch(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      })
    },
  }
}
