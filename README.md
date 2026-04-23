# @voightxyz/sdk

**Real-time observability for AI agents on Solana.**
Live timeline, on-chain audit trail, and custom alerts for any AI agent — from ElizaOS to Solana Agent Kit to custom stacks.

> Part of [Voight](https://voight.xyz). This package is the TypeScript client.
> Prefer a framework Skill or a raw HTTP call? Both work against the same API — pick whichever fits your stack.

---

## Install

```bash
npm install @voightxyz/sdk
```

Node 18+ (uses global `fetch`). Browsers, Workers, and Bun are supported.

## Usage

Three lines, any framework:

```ts
import { Voight } from '@voightxyz/sdk'

const voight = new Voight({
  agentId: 'trading-bot.sol',     // SNS domain recommended
  apiKey: process.env.VOIGHT_KEY, // from voight.xyz dashboard
})

await voight.log({
  reasoning: 'SOL/USDC spread 8bps — arb window open',
  toolExecuted: 'jupiter.swap',
  transaction: '4zK…9Fp',
})
```

Every event shows up live on your dashboard and in the public [Explorer](https://voight.xyz/explore). Anomaly detection and on-chain anchoring are automatic.

## API

### `new Voight(options)`

| Option          | Type                     | Default                                    | Description                                              |
| --------------- | ------------------------ | ------------------------------------------ | -------------------------------------------------------- |
| `agentId`       | `string`                 | —                                          | Required. Your agent's public identifier.                |
| `apiKey`        | `string`                 | —                                          | API key from the Voight dashboard.                       |
| `endpoint`      | `string`                 | `https://voight-production.up.railway.app` | Override the API endpoint (useful for self-hosting).     |
| `defaults`      | `Record<string,unknown>` | `{}`                                       | Metadata merged into every event (e.g. `{ model, env }`).|
| `swallowErrors` | `boolean`                | `true`                                     | Never throw on network failure (recommended).            |
| `fetch`         | `typeof fetch`           | `globalThis.fetch`                         | Custom fetch for tests or older runtimes.                |

### `voight.log(input)`

```ts
await voight.log({
  type: 'decision',                              // 'decision' | 'action' | 'error'
  input: { prompt: 'rebalance', context: { … } },
  reasoning: 'free-form trace',
  toolsConsidered: ['jupiter.swap', 'orca.swap'],
  toolExecuted: 'jupiter.swap',
  transaction: '4zK…9Fp',
  amount: { token: 'SOL', value: 50 },
  outcome: 'success',                            // 'pending' | 'success' | 'failed'
  metadata: { strategy: 'mean-reversion' },
})
```

Returns `{ ok: true, eventId }` on success, `{ ok: false, error }` on failure (when `swallowErrors: true`).

### `voight.check(request)` · `voight.enforce(request)` — coming in v0.2

Policy pre-check and human-in-the-loop routing. Today these return `{ allow: true, reason: 'not-implemented' }` so you can instrument call sites now; flip a flag later when the HITL module ships. No code changes needed.

```ts
const decision = await voight.check({ action: 'swap', context: { amount: 50 } })
if (!decision.allow) return // blocked by policy
```

## Connect via Skills or HTTP instead

This package isn't the only way in. Voight also ships:

- **Skills** — drop-in plugins for ElizaOS, Solana Agent Kit, LangGraph, etc. See [voight.xyz](https://voight.xyz).
- **HTTP** — any runtime that can `POST` JSON:

```bash
curl https://voight-production.up.railway.app/v1/events \
  -H "authorization: Bearer $VOIGHT_KEY" \
  -H "content-type: application/json" \
  -d '{"agentId":"trading-bot.sol","reasoning":"…","toolExecuted":"jupiter.swap"}'
```

All three paths hit the same event stream and the same dashboard.

## License

MIT © [Voight](https://voight.xyz)
