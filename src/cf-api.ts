// 空壳 Worker 代码 —— slot 未分配时返回 404
export const IDLE_WORKER_CODE = `export default {
  async fetch() {
    return new Response(JSON.stringify({error: "Slot not assigned"}), {
      status: 404,
      headers: {"Content-Type": "application/json"}
    });
  }
};`

export interface CfApi {
  updateSlotCode(slotIndex: number, code: string): Promise<void>
  initSlot(slotIndex: number): Promise<void>
  getSlotSubdomain(slotIndex: number): string
  invoke(slotIndex: number, request: Request): Promise<Response>
}

import { CONFIG } from './config.js'

export function createCfApi(accountId: string, apiToken: string): CfApi {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`

  function getSlotName(slotIndex: number): string {
    return `${CONFIG.SLOT_PREFIX}${slotIndex}`
  }

  async function putWorkerCode(name: string, code: string): Promise<void> {
    const metadata = JSON.stringify({
      main_module: 'worker.js',
      compatibility_date: '2026-04-03',
    })
    const formData = new FormData()
    formData.append('metadata', new Blob([metadata], { type: 'application/json' }))
    formData.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js')
    const resp = await fetch(`${baseUrl}/${name}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`CF API PUT worker failed (${resp.status}): ${text}`)
    }
  }

  return {
    async updateSlotCode(slotIndex: number, code: string): Promise<void> {
      await putWorkerCode(getSlotName(slotIndex), code)
    },

    async initSlot(slotIndex: number): Promise<void> {
      const name = getSlotName(slotIndex)
      await putWorkerCode(name, IDLE_WORKER_CODE)
      const subdomainResp = await fetch(`${baseUrl}/${name}/subdomain`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      if (!subdomainResp.ok) {
        console.warn(`[sigil] failed to enable subdomain for ${name}: ${subdomainResp.status}`)
      }
    },

    getSlotSubdomain(slotIndex: number): string {
      return `${getSlotName(slotIndex)}${CONFIG.SUBDOMAIN_SUFFIX}`
    },

    async invoke(slotIndex: number, request: Request): Promise<Response> {
      const subdomain = `${getSlotName(slotIndex)}${CONFIG.SUBDOMAIN_SUFFIX}`
      const url = new URL(request.url)
      const targetUrl = `https://${subdomain}${url.pathname}${url.search}`
      const headers = new Headers(request.headers)
      headers.delete('host')
      return fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'follow',
      })
    },
  }
}
