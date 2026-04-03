import { describe, it, expect } from 'vitest'
import { generateWorkerCode } from '../src/codegen.js'
import type { InputSchema } from '../src/codegen.js'

// Helper: eval the generated Worker code and call its fetch handler
async function callWorker(
  code: string,
  options: {
    method?: string
    url?: string
    body?: unknown
    searchParams?: Record<string, string>
  } = {},
): Promise<Response> {
  const { method = 'GET', url = 'https://example.com/', body, searchParams } = options

  // Build URL with search params
  const reqUrl = new URL(url)
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      reqUrl.searchParams.set(k, v)
    }
  }

  const init: RequestInit = { method }
  if (body !== undefined && (method === 'POST' || method === 'PUT')) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }

  const request = new Request(reqUrl.toString(), init)

  // Evaluate the worker code and get the default export
  const module = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(code)}`)
  const worker = module.default
  return worker.fetch(request)
}

describe('codegen: generateWorkerCode', () => {
  // Test 1: 基本代码生成
  it('schema + execute → 生成有效 Worker 代码', () => {
    const schema: InputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to greet' },
      },
    }
    const execute = `return "Hello, " + (input.name || "World") + "!"`
    const code = generateWorkerCode(schema, execute)

    expect(code).toContain('export default')
    expect(code).toContain('async fetch(request)')
    expect(code).toContain('input.name')
    expect(typeof code).toBe('string')
  })

  // Test 2: 类型转换 — number/boolean 从 query string 正确转换
  it('number 类型从 query string 正确转换', async () => {
    const schema: InputSchema = {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount' },
      },
    }
    const execute = `return JSON.stringify({ amount: input.amount, type: typeof input.amount })`
    const code = generateWorkerCode(schema, execute)

    const resp = await callWorker(code, { searchParams: { amount: '42.5' } })
    expect(resp.status).toBe(200)
    const data = await resp.json() as { amount: number; type: string }
    expect(data.amount).toBe(42.5)
    expect(data.type).toBe('number')
  })

  it('boolean 类型从 query string 正确转换', async () => {
    const schema: InputSchema = {
      type: 'object',
      properties: {
        flag: { type: 'boolean', description: 'A flag' },
      },
    }
    const execute = `return JSON.stringify({ flag: input.flag, type: typeof input.flag })`
    const code = generateWorkerCode(schema, execute)

    const respTrue = await callWorker(code, { searchParams: { flag: 'true' } })
    const dataTrue = await respTrue.json() as { flag: boolean; type: string }
    expect(dataTrue.flag).toBe(true)
    expect(dataTrue.type).toBe('boolean')

    const respFalse = await callWorker(code, { searchParams: { flag: 'false' } })
    const dataFalse = await respFalse.json() as { flag: boolean; type: string }
    expect(dataFalse.flag).toBe(false)
  })

  // Test 3: 默认值填充
  it('缺少参数时用默认值', async () => {
    const schema: InputSchema = {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount', default: 1 },
        currency: { type: 'string', description: 'Currency', default: 'USD' },
      },
    }
    const execute = `return JSON.stringify({ amount: input.amount, currency: input.currency })`
    const code = generateWorkerCode(schema, execute)

    const resp = await callWorker(code)
    expect(resp.status).toBe(200)
    const data = await resp.json() as { amount: number; currency: string }
    expect(data.amount).toBe(1)
    expect(data.currency).toBe('USD')
  })

  // Test 4: required 校验 — 缺少必填参数返回 400
  it('缺少 required 参数返回 400', async () => {
    const schema: InputSchema = {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['from', 'to'],
    }
    const execute = `return JSON.stringify({ from: input.from, to: input.to })`
    const code = generateWorkerCode(schema, execute)

    // Missing both required params
    const resp1 = await callWorker(code)
    expect(resp1.status).toBe(400)
    const data1 = await resp1.json() as { error: string }
    expect(data1.error).toContain('Missing required parameter: from')

    // Only `from` provided
    const resp2 = await callWorker(code, { searchParams: { from: 'USD' } })
    expect(resp2.status).toBe(400)
    const data2 = await resp2.json() as { error: string }
    expect(data2.error).toContain('Missing required parameter: to')

    // Both provided — should succeed
    const resp3 = await callWorker(code, { searchParams: { from: 'USD', to: 'CNY' } })
    expect(resp3.status).toBe(200)
  })

  // Test 5: 空 schema — 无参数的函数
  it('空 schema — 无参数的函数正常运行', async () => {
    const schema: InputSchema = { properties: {} }
    const execute = `return "hello world"`
    const code = generateWorkerCode(schema, execute)

    const resp = await callWorker(code)
    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(text).toBe('hello world')
  })

  // Test 6: POST body 解析 — JSON body 正确读取
  it('POST body 解析 — JSON body 正确读取', async () => {
    const schema: InputSchema = {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
      },
    }
    const execute = `return JSON.stringify({ sum: input.x + input.y })`
    const code = generateWorkerCode(schema, execute)

    const resp = await callWorker(code, {
      method: 'POST',
      body: { x: 10, y: 20 },
    })
    expect(resp.status).toBe(200)
    const data = await resp.json() as { sum: number }
    expect(data.sum).toBe(30)
  })

  // Test 7: 错误处理 — execute 抛错返回 500
  it('execute 抛错返回 500', async () => {
    const schema: InputSchema = { properties: {} }
    const execute = `throw new Error("intentional error")`
    const code = generateWorkerCode(schema, execute)

    const resp = await callWorker(code)
    expect(resp.status).toBe(500)
    const data = await resp.json() as { error: string }
    expect(data.error).toContain('intentional error')
  })

  // Test 8: query params override POST body
  it('query params 覆盖 POST body 同名参数', async () => {
    const schema: InputSchema = {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    }
    const execute = `return input.value`
    const code = generateWorkerCode(schema, execute)

    const resp = await callWorker(code, {
      method: 'POST',
      url: 'https://example.com/?value=from-query',
      body: { value: 'from-body' },
    })
    expect(resp.status).toBe(200)
    const text = await resp.text()
    // query params should override body
    expect(text).toBe('from-query')
  })

  // Test 9: non-string output auto-stringified
  it('非 string 返回值自动 JSON 序列化', async () => {
    const schema: InputSchema = { properties: {} }
    const execute = `return { hello: "world", num: 42 }`
    const code = generateWorkerCode(schema, execute)

    const resp = await callWorker(code)
    expect(resp.status).toBe(200)
    const data = await resp.json() as { hello: string; num: number }
    expect(data.hello).toBe('world')
    expect(data.num).toBe(42)
  })
})
