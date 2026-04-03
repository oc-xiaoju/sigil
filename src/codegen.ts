export interface SchemaProperty {
  type: string
  description?: string
  default?: any
}

export interface InputSchema {
  type?: 'object'
  properties: Record<string, SchemaProperty>
  required?: string[]
}

/**
 * 从 schema + execute body 生成完整 Worker 代码
 */
export function generateWorkerCode(schema: InputSchema, executeBody: string): string {
  const required = schema.required || []

  // 生成参数解析 + 类型转换
  const parseLines: string[] = []
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    if (prop.type === 'number') {
      parseLines.push(`      if (raw.${name} !== undefined) input.${name} = Number(raw.${name});`)
    } else if (prop.type === 'boolean') {
      parseLines.push(`      if (raw.${name} !== undefined) input.${name} = raw.${name} === 'true' || raw.${name} === true;`)
    } else {
      parseLines.push(`      if (raw.${name} !== undefined) input.${name} = raw.${name};`)
    }
    // 默认值
    if (prop.default !== undefined) {
      parseLines.push(`      if (input.${name} === undefined) input.${name} = ${JSON.stringify(prop.default)};`)
    }
  }

  // 生成 required 校验
  const requiredChecks = required.map(name =>
    `      if (input.${name} === undefined) return new Response(JSON.stringify({error: "Missing required parameter: ${name}"}), {status: 400, headers: {"Content-Type": "application/json"}});`
  ).join('\n')

  return `export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      let raw = {};

      // Parse input from query params or JSON body
      if (request.method === 'POST' || request.method === 'PUT') {
        try { raw = await request.json(); } catch(e) { raw = {}; }
      }
      // Query params override/merge
      for (const [k, v] of url.searchParams.entries()) {
        raw[k] = v;
      }

      const input = {};
${parseLines.join('\n')}

      // Required field validation
${requiredChecks}

      // Execute user function
      const __result = await (async (input) => {
        ${executeBody}
      })(input);

      // Ensure string output
      const output = typeof __result === 'string' ? __result : JSON.stringify(__result);
      return new Response(output, {
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};`
}
