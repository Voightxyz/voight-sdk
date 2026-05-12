<div align="center">

# @voightxyz/sdk

**Real-time observability + on-chain trust for AI agents.**

Live timeline, privacy-first capture, anomaly alerts, and tamper-evident logs anchored on Solana — for any AI agent, including the one inside your editor.

[![npm](https://img.shields.io/npm/v/@voightxyz/sdk.svg)](https://www.npmjs.com/package/@voightxyz/sdk)
[![license](https://img.shields.io/npm/l/@voightxyz/sdk.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@voightxyz/sdk.svg)](https://nodejs.org)

[Dashboard](https://voight.xyz/dashboard) · [Explorer](https://voight.xyz/explore) · [Voight repo](https://github.com/Voightxyz/voight)

</div>

---

## Wire it into Claude Code in one paste

```bash
npx -y @voightxyz/sdk setup
```

The wizard asks you to pick a privacy level (Minimal · Standard ★ · Full) and your API key, wires the hooks into `~/.claude/settings.json`, and you're done. Every prompt, tool call, bash, and file edit Claude Code does streams to your dashboard. **No code changes.**

Generate your API key at [voight.xyz/dashboard](https://voight.xyz/dashboard).

---

## Or import the library directly

For agents you build yourself (autonomous bots, ElizaOS / Solana Agent Kit, custom runtimes):

```bash
npm install @voightxyz/sdk
```

Node 18+ (uses global `fetch`). Browsers, Workers, and Bun are supported.

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

Every event shows up live on your dashboard. Anomaly detection and (on-chain anchoring, coming v1.0) are automatic.

---

## Privacy — pick what leaves your machine

Voight's hosted backend reads whatever events you ship — the same trade-off any SaaS observability service makes. The setup wizard lets you tier the capture so credentials and personal info never leave your machine in the first place:

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

Every event ships with `metadata.privacyLevel` so the dashboard can render a per-event chip and you can audit retroactively how each row was captured. Existing users on SDK ≤0.3.10 default to `full` until they re-run setup — no silent privacy upgrade.

The full PII pattern set (12 patterns + Luhn-validated card detection) lives in [`src/privacy.ts`](./src/privacy.ts).

---

## API

### `new Voight(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `agentId` | `string` | — | Required. Your agent's public identifier. |
| `apiKey` | `string` | — | API key from the Voight dashboard. |
| `endpoint` | `string` | `https://voight-production.up.railway.app` | Override the API endpoint (useful for self-hosting). |
| `defaults` | `Record<string,unknown>` | `{}` | Metadata merged into every event (e.g. `{ model, env }`). |
| `swallowErrors` | `boolean` | `true` | Never throw on network failure (recommended). |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch for tests or older runtimes. |

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

### `voight.check(request)` · `voight.enforce(request)` — coming in v1.0

Policy pre-check and human-in-the-loop routing. Today these return `{ allow: true, reason: 'not-implemented' }` so you can instrument call sites now; flip a flag later when the HITL module ships. No code changes needed.

```ts
const decision = await voight.check({ action: 'swap', context: { amount: 50 } })
if (!decision.allow) return // blocked by policy
```

---

## Install targets

The `setup` command writes hooks into different settings paths based on `--target`:

| Target | Path | State |
| --- | --- | --- |
| `claude` (default) | `~/.claude/settings.json` | ✅ Verified — production install path |
| `cursor` | `~/.cursor/settings.json` | 🟡 Scaffolded, validation in flight |
| `codex` | `~/.codex/settings.json` | 🟡 Scaffolded, validation in flight |

Targets for Gemini, Replit Agent, and other coding-agent surfaces are on the roadmap.

---

## Connect via HTTP

If you don't want a dependency at all, any runtime that can `POST` JSON works:

```bash
curl https://voight-production.up.railway.app/v1/events \
  -H "authorization: Bearer $VOIGHT_KEY" \
  -H "content-type: application/json" \
  -d '{"agentId":"trading-bot.sol","reasoning":"…","toolExecuted":"jupiter.swap"}'
```

Same event stream, same dashboard, same alerts.

---

## Architecture

```
src/
├── cli.ts          npx -y @voightxyz/sdk <cmd> entry
├── setup.ts        Setup wizard — privacy level prompt + API key + hooks
├── hook.ts         Hook handler — reads stdin JSON, maps to LogInput
├── transcript.ts   Reads Claude Code transcripts for token attribution
├── privacy.ts      PII scrubbing + per-event privacy filter
├── git.ts          Git context capture (branch / sha / remote)
├── wakeup.ts       ScheduleWakeup recognition
├── denials.ts      Permission-denial classification
└── index.ts        Public `Voight` class
```

The hook subprocess is short-lived (one per Claude Code lifecycle event) and never throws — failures are swallowed so they can't crash the host editor.

---

## Status

| Capability | State |
| --- | --- |
| Library mode (`voight.log()`) | ✅ Shipped |
| Claude Code hook integration | ✅ Shipped, verified install path |
| Transcript-based token capture | ✅ Shipped |
| 3-level privacy capture + PII scrubbing | ✅ Shipped (0.4.x) |
| Setup wizard (TTY + non-TTY 3-step flow) | ✅ Shipped (0.4.1+) |
| Git context capture | ✅ Shipped |
| Wakeup/system-prompt classification | ✅ Shipped |
| Permission-denial classification | ✅ Shipped (architectural caveats — see code comments) |
| Cursor / Codex install targets | 🟡 Scaffolded, validation in flight |
| `voight.check()` / `voight.enforce()` (HITL) | 🟡 No-op today, v1.0 |
| Solana hash anchoring of events | 🟡 v1.0 |
| Framework Skills (`@voightxyz/eliza-skill`, etc.) | 🔴 Roadmap, separate packages |

---

## Local development

```bash
npm install
npm test         # Vitest — currently 138 tests
npm run type-check
npm run build    # tsup — produces ESM + CJS + .d.ts in dist/
```

To test the wizard locally against a build:

```bash
npm run build
node dist/cli.js setup --privacy=2 --key=vk_test
```

---

## Companion repo

Voight's hosted backend (Fastify API + Next.js dashboard + Solana indexers + Postgres) lives in **[`voightxyz/voight`](https://github.com/Voightxyz/voight)**. This SDK is the only piece that runs on your machine.

---

## License

Apache 2.0 © [Voight](https://voight.xyz)

See [`LICENSE`](./LICENSE) for full terms. Includes patent grant + trademark protection.
