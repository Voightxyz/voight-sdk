# @voightxyz/sdk

**Real-time observability for AI agents on Solana.**
Live timeline, on-chain audit trail, and alerts — for any AI agent, including the one inside your editor.

> Part of [Voight](https://voight.xyz).

---

## Wire it into Claude Code in one command

```bash
npx -y @voightxyz/sdk setup
```

Generate your key at [voight.xyz/dashboard](https://voight.xyz/dashboard), paste it when prompted, and every prompt + tool call + bash + file edit Claude Code does starts streaming to your dashboard. No code changes.

Cursor and Codex use the same flow:

```bash
npx -y @voightxyz/sdk setup --target=cursor
npx -y @voightxyz/sdk setup --target=codex
```

---

## Or import the library directly

For agents you build yourself:

```bash
npm install @voightxyz/sdk
```

Node 18+ (uses global `fetch`). Browsers, Workers, and Bun are supported.

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

## Privacy: pick what leaves your machine

Voight's hosted backend reads whatever events you ship — the same trade-off any SaaS observability service makes. If you'd rather not trust the operator with raw content, the setup wizard tiers the capture:

```
$ npx -y @voightxyz/sdk setup
  ...
  1) Minimal   — metadata only (tool names, timing, outcomes, tokens, USD).
                 No prompts, responses, or file paths leave your machine.
  2) Standard  — full content + local PII scrubbing.            ★ recommended
                 Credentials and personal info (API keys, JWTs, emails,
                 credit cards, PEM blocks, phone) are redacted on your
                 machine BEFORE transmission.
  3) Full      — everything captured as-is. Backwards-compat default.
```

Tokens, USD spend, model names, and latency stats are numeric / tag data — they pass through unchanged in **all three** levels, so the dashboard's KPIs and charts work identically regardless of what you pick.

The level lives in `~/.claude/settings.json` (`env.VOIGHT_PRIVACY`). Switch any time by re-running `npx -y @voightxyz/sdk setup` (the wizard remembers your current value), or override via env var for one session:

```bash
VOIGHT_PRIVACY=minimal claude   # or 'standard' / 'full'
```

Every event ships with `metadata.privacyLevel` so the dashboard can render a per-event chip and you can audit retroactively how each row was captured. Existing users on SDK ≤0.3.10 default to `full` until they re-run setup — there's no silent privacy upgrade.

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
