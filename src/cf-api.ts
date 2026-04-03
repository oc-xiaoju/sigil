// Refactored: cf-api.ts now only provides optional legacy cleanup (deleteWorker).
// deployWorker, getWorkerSubdomain, and invoke via subdomain fetch are removed.
// Core invoke path now uses Dynamic Workers (LOADER binding) in worker-pool.ts.

/**
 * Optional CF API helpers for legacy script cleanup.
 * Only deleteWorker is retained; deploy and subdomain helpers are gone.
 */
export interface LegacyCfApi {
  deleteWorker(name: string): Promise<void>
}

export function createLegacyCfApi(accountId: string, apiToken: string): LegacyCfApi {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`

  return {
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
  }
}