# AMD 风格 Capability 组合功能演示

本演示展示 Sigil 新增的 AMD 风格依赖管理功能。

## 1. 基础依赖注入

### 部署基础 capability

```bash
curl -X POST https://sigil.example.com/_api/deploy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github-token",
    "execute": "return \"ghp_example_token\";",
    "type": "normal",
    "description": "获取 GitHub API token"
  }'
```

### 部署依赖该 capability 的服务

```bash
curl -X POST https://sigil.example.com/_api/deploy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github-api",
    "schema": {
      "type": "object",
      "properties": {
        "endpoint": {"type": "string"},
        "method": {"type": "string", "default": "GET"}
      },
      "required": ["endpoint"]
    },
    "execute": "const token = await deps[\"github-token\"](); const response = await fetch(`https://api.github.com${input.endpoint}`, { method: input.method, headers: { \"Authorization\": `Bearer ${token}` } }); return response.json();",
    "type": "normal",
    "description": "GitHub API 客户端",
    "requires": ["github-token"]
  }'
```

## 2. 多依赖组合

### 部署翻译服务

```bash
curl -X POST https://sigil.example.com/_api/deploy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "translate",
    "schema": {
      "type": "object", 
      "properties": {
        "text": {"type": "string"},
        "lang": {"type": "string", "default": "zh"}
      },
      "required": ["text"]
    },
    "execute": "return `[${input.lang}] ${input.text}`;",
    "type": "normal"
  }'
```

### 部署使用多个依赖的服务

```bash
curl -X POST https://sigil.example.com/_api/deploy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "repo-summary",
    "schema": {
      "type": "object",
      "properties": {
        "repo": {"type": "string"}
      },
      "required": ["repo"]
    },
    "execute": "const repoData = await deps[\"github-api\"]({endpoint: `/repos/${input.repo}`}); const summary = await deps[\"translate\"]({text: repoData.description, lang: \"zh\"}); return {name: repoData.name, description_cn: summary, stars: repoData.stargazers_count};",
    "type": "normal",
    "description": "获取仓库信息并翻译描述",
    "requires": ["github-api", "translate"]
  }'
```

## 3. 链式依赖

### A depends on B, B depends on C

```bash
# 部署 C (基础服务)
curl -X POST https://sigil.example.com/_api/deploy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "base-logger",
    "execute": "return `[LOG] ${new Date().toISOString()}`;",
    "type": "normal"
  }'

# 部署 B (中间层，依赖 C)
curl -X POST https://sigil.example.com/_api/deploy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "middleware",
    "schema": {
      "type": "object",
      "properties": {
        "action": {"type": "string"}
      }
    },
    "execute": "const log = await deps[\"base-logger\"](); return `${log} [MIDDLEWARE] ${input.action || \"unknown\"}`;",
    "type": "normal",
    "requires": ["base-logger"]
  }'

# 部署 A (顶层，依赖 B)
curl -X POST https://sigil.example.com/_api/deploy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "api-handler",
    "schema": {
      "type": "object",
      "properties": {
        "request": {"type": "string"}
      }
    },
    "execute": "const mid = await deps[\"middleware\"]({action: \"handle_request\"}); return `${mid} [API] Processing: ${input.request}`;",
    "type": "normal", 
    "requires": ["middleware"]
  }'
```

## 4. 调用示例

```bash
# 调用 repo-summary (会自动使用其所有依赖)
curl "https://sigil.example.com/run/repo-summary?repo=microsoft/vscode"

# 调用 api-handler (会自动使用链式依赖)
curl "https://sigil.example.com/run/api-handler?request=get_user_data"
```

## 5. 生成的代码结构

当使用 `requires` 时，生成的 Worker 代码包含：

```javascript
export default {
  async fetch(request) {
    // ... 输入解析 ...
    
    // AMD deps - 每个依赖内联为函数
    const deps = {
      'github-token': async (params = {}) => {
        const input = params;
        return "ghp_example_token";
      },
      'translate': async (params = {}) => {
        const input = {};
        if (params.text !== undefined) input.text = params.text;
        if (params.lang !== undefined) input.lang = params.lang;
        if (input.lang === undefined) input.lang = "zh";
        return `[${input.lang}] ${input.text}`;
      }
    };

    // Execute user function (with deps)
    const __result = await (async (input, deps) => {
      const repoData = await deps["github-api"]({endpoint: `/repos/${input.repo}`});
      const summary = await deps["translate"]({text: repoData.description, lang: "zh"});
      return {name: repoData.name, description_cn: summary, stars: repoData.stargazers_count};
    })(input, deps);

    // ... 输出处理 ...
  }
};
```

## 6. 循环依赖检测

尝试创建循环依赖会被自动检测并阻止：

```bash
# 这会失败，因为会创建 A -> A 循环
curl -X POST https://sigil.example.com/_api/deploy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "self-ref",
    "execute": "const self = await deps[\"self-ref\"](); return self;",
    "type": "normal",
    "requires": ["self-ref"]
  }'
```

错误响应：
```json
{
  "error": "Failed to resolve dependencies: Circular dependency detected: self-ref -> self-ref"
}
```

## 特性总结

✅ **依赖声明**: `requires` 字段声明依赖关系  
✅ **自动 bundle**: 依赖代码自动内联到主 capability  
✅ **循环检测**: 防止无限递归的循环依赖  
✅ **参数解析**: 依赖支持 schema 参数验证  
✅ **向后兼容**: 现有 capability 不受影响  
✅ **递归解析**: 支持多层依赖链（A->B->C）  
✅ **类型安全**: TypeScript 严格模式支持