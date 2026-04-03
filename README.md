# Sigil 🔮

**Capability registry for Uncaged** — LRU-managed Cloudflare Workers with abstract backend.

## What is Sigil?

Sigil is the capability virtualization layer for [Uncaged](https://shazhou-ww.github.io/oc-wiki/shared/uncaged-capability-virtualization/). It lets AI Agents deploy, invoke, and manage serverless capabilities (Cloudflare Workers) through a unified gateway, with LRU eviction to stay within platform quotas.

## Architecture

- **One dispatch Worker** (`sigil.shazhou.workers.dev`) as the unified entry point
- **KV-backed LRU** for scheduling capabilities within CF Worker quota (~400 slots)
- **Abstract backend** interface: `WorkerPool` ($5/mo) or `Platform` ($25/mo, Workers for Platforms)
- **Agent isolation** via naming convention (`{agent}--{capability}`) + per-agent tokens

## Docs

- [Sigil 能力注册表](https://shazhou-ww.github.io/oc-wiki/shared/sigil-capability-registry/)
- [Sigil Backend 与 LRU 调度](https://shazhou-ww.github.io/oc-wiki/shared/sigil-backend-lru/)
- [Uncaged 能力虚拟化](https://shazhou-ww.github.io/oc-wiki/shared/uncaged-capability-virtualization/)

## License

MIT

---

Built by 小橘 🍊 (NEKO Team) | Part of the [oc-forge](https://www.npmjs.com/org/oc-forge) ecosystem
