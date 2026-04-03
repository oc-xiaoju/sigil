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

export interface DependencyInfo {
  code: string
  schema?: InputSchema
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

/**
 * 从 schema + execute body + 依赖生成完整 Worker 代码（AMD 风格）
 */
export function generateWorkerCodeWithDeps(
  schema: InputSchema,
  executeBody: string,
  deps: Record<string, DependencyInfo>
): string {
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

  // 生成依赖函数
  const depsCode = Object.entries(deps).map(([depName, depInfo]) => {
    const depSchema = depInfo.schema
    if (!depSchema) {
      // 无 schema，直接执行
      return `        '${depName}': async (params = {}) => {
          const input = params;
          ${depInfo.code}
        }`
    }

    // 有 schema，需要参数解析
    const depParseLines: string[] = []
    for (const [name, prop] of Object.entries(depSchema.properties || {})) {
      if (prop.type === 'number') {
        depParseLines.push(`          if (params.${name} !== undefined) input.${name} = Number(params.${name});`)
      } else if (prop.type === 'boolean') {
        depParseLines.push(`          if (params.${name} !== undefined) input.${name} = params.${name} === 'true' || params.${name} === true;`)
      } else {
        depParseLines.push(`          if (params.${name} !== undefined) input.${name} = params.${name};`)
      }
      // 默认值
      if (prop.default !== undefined) {
        depParseLines.push(`          if (input.${name} === undefined) input.${name} = ${JSON.stringify(prop.default)};`)
      }
    }

    return `        '${depName}': async (params = {}) => {
          const input = {};
${depParseLines.join('\n')}
          ${depInfo.code}
        }`
  }).join(',\n')

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

      // AMD deps - 每个依赖内联为函数
      const deps = {
${depsCode}
      };

      // Execute user function (with deps)
      const __result = await (async (input, deps) => {
        ${executeBody}
      })(input, deps);

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
