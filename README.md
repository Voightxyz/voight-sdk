<div align="center">

# @voightxyz/sdk

**Real-time observability for AI coding agents and production LLM apps.**

Hooks for Claude Code and Cursor (zero code changes), library mode for custom Node bots, and a `init` wizard that scaffolds the companion wrapper SDKs ([`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai), [`@voightxyz/anthropic`](https://www.npmjs.com/package/@voightxyz/anthropic)) into production apps in 30 seconds. One backend, one dashboard, one SDK family.

[![npm](https://img.shields.io/npm/v/@voightxyz/sdk.svg)](https://www.npmjs.com/package/@voightxyz/sdk)
[![license](https://img.shields.io/npm/l/@voightxyz/sdk.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@voightxyz/sdk.svg)](https://nodejs.org)

[Dashboard](https://voight.xyz/dashboard) · [Explorer](https://voight.xyz/explore) · [Voight repo](https://github.com/Voightxyz/voight)

</div>

---

## Wire it into your coding agent in one paste

```bash
npx -y @voightxyz/sdk setup
```

The wizard auto-detects whether you're calling from Claude Code, Cursor, or Codex (via env signals: `CLAUDECODE` / `CURSOR_TRACE_ID` / `CODEX_THREAD_ID`) and writes the right hook config in the right place. Pick a privacy level (Minimal · Standard ★ · Full), paste your API key, and every prompt, tool call, bash, and file edit your agent does streams to your dashboard. **No code changes.**

Generate your API key at [voight.xyz/dashboard](https://voight.xyz/dashboard).

Run from a generic terminal? Pass `--target=claude|cursor|codex` to skip detection.

---

## Or import the library directly

For agents you build yourself (autonomous Node bots, custom runtimes, anything that talks JSON to an HTTP API):

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

## Or scaffold Voight into a production LLM app

For apps that already call OpenAI or Anthropic in production, a separate sub-command scaffolds the wrapper SDKs without any copy-paste:

```bash
cd your-app
npx -y @voightxyz/sdk init
```

The wizard detects `openai` and/or `@anthropic-ai/sdk` in your `package.json`, prompts for a privacy level + Voight key + agent name, validates the key against the API, and writes a ready-to-import `src/lib/voight.ts` with the wrapped clients. Tailors the usage snippet to your framework (Next.js or vanilla) and prints the right install command for your package manager (pnpm / yarn / bun / npm). Full walkthrough at [docs.voight.xyz/ai-apps/wizard](https://docs.voight.xyz/ai-apps/wizard).

The wrappers themselves live in separate packages so apps that need only one can install only one:

- [`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai) — wraps the OpenAI Node SDK (Chat Completions + Responses API)
- [`@voightxyz/anthropic`](https://www.npmjs.com/package/@voightxyz/anthropic) — wraps the Anthropic Node SDK (Messages API, cache breakpoints)

Both share `withTrace` / `log` / per-user `tags` for request-boundary tracing and per-customer cost attribution. See [docs.voight.xyz/concepts/per-user-spend](https://docs.voight.xyz/concepts/per-user-spend) for the customer-attribution pattern.

`init` writes only inside your project directory — it never touches `~/.claude`, `~/.cursor`, or `~/.codex`. Distinct from `setup`, which wires IDE-level hooks for the coding-agent flow above.

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

| Target | Path written | State |
| --- | --- | --- |
| `claude` | `~/.claude/settings.json` (env + hooks block) | ✅ Verified |
| `cursor` | `~/.cursor/hooks.json` + `~/.cursor/hooks/voight.sh` wrapper | ✅ Verified (0.5.0) |
| `codex` | `~/.codex/plugins/voight-marketplace/` (local marketplace + plugin) + `~/.codex/config.toml` registration | 🟡 In active fix (Codex sandbox blocks hooks from reaching the SDK) |

Defaults to auto-detect — set explicitly with `--target=<name>` when the env signals are ambiguous (CI, generic terminals).

Cursor's hooks schema has no env block, so the setup writes a small wrapper script (`~/.cursor/hooks/voight.sh`) that exports `VOIGHT_KEY` and `VOIGHT_PRIVACY` before invoking the hook handler. Codex uses a similar wrapper inside a local marketplace plugin (no external repo required — registered via `source_type = "local"` in config.toml). Other targets keep the env directly in their settings file.

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
├── setup.ts        Setup wizard — target auto-detect, privacy prompt, API key, hooks writer
├── hook.ts         Hook handler — reads stdin JSON, dispatches per agent
├── cursor.ts       Cursor adapter — translates Cursor's 11 hook events to LogInput
├── transcript.ts   Reads Claude Code transcripts for token attribution
├── privacy.ts      PII scrubbing + per-event privacy filter
├── git.ts          Git context capture (branch / sha / remote)
├── wakeup.ts       ScheduleWakeup recognition
├── denials.ts      Permission-denial classification
└── index.ts        Public `Voight` class
```

The hook subprocess is short-lived (one per agent lifecycle event) and never throws — failures are swallowed so they can't crash the host editor.

---

## Status

| Capability | State |
| --- | --- |
| Library mode (`voight.log()`) | ✅ Shipped |
| Claude Code hook integration | ✅ Shipped, verified install path |
| Cursor install target (11 hook events, auto-detect) | ✅ Shipped (0.5.0) |
| Transcript-based token capture | ✅ Shipped |
| 3-level privacy capture + PII scrubbing | ✅ Shipped (0.4.x) |
| `setup` wizard for coding agents (TTY + non-TTY) | ✅ Shipped (0.4.1+) |
| `init` wizard for production LLM apps (OpenAI + Anthropic detection, framework-aware) | ✅ Shipped (0.6.4) |
| Companion App SDK wrappers ([`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai), [`@voightxyz/anthropic`](https://www.npmjs.com/package/@voightxyz/anthropic)) | ✅ Shipped (separate packages) |
| Git context capture | ✅ Shipped |
| Wakeup/system-prompt classification | ✅ Shipped |
| Permission-denial classification | ✅ Shipped (architectural caveats — see code comments) |
| Codex install target | 🟡 In active fix (sandbox connectivity work) |
| `voight.check()` / `voight.enforce()` (HITL) | 🟡 No-op today, v1.0 |
| Solana hash anchoring of events | 🟡 v1.0 |

---

## Local development

```bash
npm install
npm test         # Vitest
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
