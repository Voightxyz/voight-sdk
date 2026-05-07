/**
 * Privacy: 3-level capture model + local PII scrubbing.
 *
 * Three levels (set via `VOIGHT_PRIVACY` env or settings.json):
 *   - 'minimal'  → metadata only (tool names, timing, outcomes,
 *                  tokens, USD). No prompts, responses, file paths,
 *                  cwd, git, error messages.
 *   - 'standard' → everything 'full' captures, BUT every string is
 *                  swept by `scrubPii` before transmission. The
 *                  patterns target credentials + personal info
 *                  (API keys, JWTs, emails, credit cards, phone,
 *                  PEM blocks). Anthropic's billing data (token
 *                  counts, model names) is NOT scrubbed — those
 *                  are pure numerics with no PII risk.
 *   - 'full'     → everything as-is. Backwards-compat default for
 *                  users on SDK <0.4.0 who haven't re-run setup.
 *
 * `scrubPii` is a pure function: same input → same output, no I/O,
 * no randomness, safe to call in a hot path.
 */
import type { LogInput } from './index.js'

export type PrivacyLevel = 'minimal' | 'standard' | 'full'

export const PRIVACY_LEVELS: readonly PrivacyLevel[] = [
  'minimal',
  'standard',
  'full',
] as const

export const DEFAULT_PRIVACY_LEVEL: PrivacyLevel = 'full'

export function isPrivacyLevel(value: unknown): value is PrivacyLevel {
  return (
    typeof value === 'string' &&
    (PRIVACY_LEVELS as readonly string[]).includes(value)
  )
}

/**
 * Resolve the active privacy level for the current process.
 *
 * Source of truth (highest priority first):
 *   1. `VOIGHT_PRIVACY` env var — supplied either directly OR via the
 *      `env` block in `~/.claude/settings.json`, which Claude Code
 *      injects into the hook subprocess (same mechanism as
 *      VOIGHT_KEY).
 *   2. Default `'full'` — preserves SDK <0.4.0 capture behaviour for
 *      users who upgrade `npx -y @voightxyz/sdk` without re-running
 *      setup. Migration is opt-in by re-running the wizard.
 *
 * Empty / whitespace-only values are treated as unset. Unknown values
 * fall through to the default with a single `console.warn` so the
 * dev sees the problem in their terminal without crashing the host.
 *
 * Pure: takes `env` as a parameter so tests don't have to mutate
 * `process.env`. Defaults to `process.env` when called bare.
 */
export function resolvePrivacyLevel(
  env: Record<string, string | undefined> = process.env,
): PrivacyLevel {
  const raw = env.VOIGHT_PRIVACY
  if (typeof raw !== 'string') return DEFAULT_PRIVACY_LEVEL
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0) return DEFAULT_PRIVACY_LEVEL
  if (isPrivacyLevel(trimmed)) return trimmed
  // Stay quiet about HOW we resolved — this runs once per hook
  // subprocess and the user's terminal is shared with Claude Code.
  console.warn(
    `[voight] Unknown VOIGHT_PRIVACY="${raw}" — falling back to ` +
      `"${DEFAULT_PRIVACY_LEVEL}". Valid values: ${PRIVACY_LEVELS.join(', ')}.`,
  )
  return DEFAULT_PRIVACY_LEVEL
}

// ─── PII patterns ──────────────────────────────────────────────────
//
// Order matters. Multi-line / most-specific patterns run FIRST so
// that once they consume a span (e.g. an entire PEM block), later
// patterns won't re-match its insides. JWTs run before generic
// API-key patterns to avoid accidental partial matches.
//
// Each pattern has a `name` for unit-test traceability and a `re`
// that uses the global flag (so `replaceAll` semantics apply).
//
// Adding a pattern: append a new entry, add a unit test in
// `privacy.test.ts`. Don't reorder existing entries lightly —
// false-positive risk grows with regex breadth.

type Pattern = {
  name: string
  re: RegExp
  replacement: string
}

// PEM-encoded private key block. Multi-line. Must be first so the
// inner base64 body never gets parsed by other patterns.
const RE_PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g

// JSON Web Token: `header.payload.signature`, header always starts
// `eyJ`. Tight enough that legitimate dotted base64 rarely matches.
const RE_JWT =
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g

// Anthropic API key (must precede generic `sk-` so OpenAI rule
// doesn't fire first and replace only part of the string).
const RE_ANTHROPIC = /\bsk-ant-[A-Za-z0-9_-]{40,}\b/g

// OpenAI keys: classic (sk-...) and project-scoped (sk-proj-...).
// Anthropic is already scrubbed by the time this runs.
const RE_OPENAI = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g

// Stripe live keys, both secret and publishable. Test keys
// (`sk_test_`, `pk_test_`) are intentionally NOT scrubbed —
// they're meant to appear in code/logs and don't move money.
const RE_STRIPE_LIVE = /\b(?:sk|pk)_live_[A-Za-z0-9]{20,}\b/g

// GitHub fine-grained PATs are 82 chars after `github_pat_`.
// Classic PATs are 36 chars after `ghp_`.
const RE_GITHUB_FINE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g
const RE_GITHUB_CLASSIC = /\bghp_[A-Za-z0-9]{36}\b/g

// AWS access key IDs always start with `AKIA` followed by 16
// uppercase alphanumerics.
const RE_AWS_ACCESS_KEY = /\bAKIA[A-Z0-9]{16}\b/g

// Slack tokens: xoxb / xoxp / xoxa / xoxr / xoxs.
const RE_SLACK = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g

// Voight's own keys. Defense-in-depth: even if the user pastes
// `vk_…` into a prompt or commit message, it never leaves the
// machine in the clear under Standard. Voight keys are base64url
// (43 chars) so the body includes `-` and `_`.
const RE_VOIGHT = /\bvk_[A-Za-z0-9_-]{32,}\b/g

// Email. Strict-ish: requires a TLD with at least two letters.
// `email_template` doesn't match (no @). `support@app` doesn't
// match either (no TLD dot).
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

// Phone in E.164 format. Looser patterns produce too many
// false positives over numeric IDs / order numbers.
const RE_PHONE_E164 = /\+\d{10,15}\b/g

const KEY_PATTERNS: readonly Pattern[] = [
  { name: 'pem-private-key', re: RE_PEM_PRIVATE_KEY, replacement: '[REDACTED-PRIVATE-KEY]' },
  { name: 'jwt', re: RE_JWT, replacement: '[REDACTED-JWT]' },
  { name: 'anthropic-key', re: RE_ANTHROPIC, replacement: '[REDACTED-API-KEY]' },
  { name: 'openai-key', re: RE_OPENAI, replacement: '[REDACTED-API-KEY]' },
  { name: 'stripe-live-key', re: RE_STRIPE_LIVE, replacement: '[REDACTED-API-KEY]' },
  { name: 'github-fine-pat', re: RE_GITHUB_FINE, replacement: '[REDACTED-API-KEY]' },
  { name: 'github-classic-pat', re: RE_GITHUB_CLASSIC, replacement: '[REDACTED-API-KEY]' },
  { name: 'aws-access-key', re: RE_AWS_ACCESS_KEY, replacement: '[REDACTED-API-KEY]' },
  { name: 'slack-token', re: RE_SLACK, replacement: '[REDACTED-API-KEY]' },
  { name: 'voight-key', re: RE_VOIGHT, replacement: '[REDACTED-API-KEY]' },
  { name: 'email', re: RE_EMAIL, replacement: '[REDACTED-EMAIL]' },
  { name: 'phone-e164', re: RE_PHONE_E164, replacement: '[REDACTED-PHONE]' },
]

// Credit cards need Luhn validation, so they don't fit the simple
// {re, replacement} pattern table.

/**
 * Validate a digit string against the Luhn checksum used by all major
 * card brands. Returns false on empty / non-digit input.
 */
export function luhnValid(digits: string): boolean {
  if (digits.length === 0) return false
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charCodeAt(i)
    if (ch < 48 || ch > 57) return false
    let n = ch - 48
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  return sum > 0 && sum % 10 === 0
}

// Match candidate card numbers: 13–19 digits, optionally with single
// spaces or dashes between groups. Anchored with \b so we don't match
// the middle of a longer digit string.
const RE_CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g

function scrubCreditCards(input: string): string {
  return input.replace(RE_CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, '')
    if (digits.length < 13 || digits.length > 19) return match
    if (!luhnValid(digits)) return match
    return '[REDACTED-CARD]'
  })
}

/**
 * Run the credential / PII patterns over a string. Pure: same input
 * → same output, idempotent (already-scrubbed strings stay stable),
 * no I/O. Returns the input unchanged if no pattern matches.
 *
 * Designed to run on every event payload string under Standard
 * privacy mode (~12 patterns, target <10ms for 2KB inputs).
 */
export function scrubPii(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input
  let out = input
  for (const { re, replacement } of KEY_PATTERNS) {
    // RegExp objects with the `g` flag carry a `lastIndex` that's
    // mutated by `exec`. We only ever use them via `replace`, which
    // resets internally — but pin a fresh regex each call to be
    // extra-safe under concurrent invocations (Node single-threaded
    // makes this a no-op today, just guards future Worker use).
    out = out.replace(new RegExp(re.source, re.flags), replacement)
  }
  out = scrubCreditCards(out)
  return out
}

/**
 * Internal: exposed for unit tests so we can assert pattern coverage
 * without parsing source. Don't depend on this from runtime code.
 */
export function _patternNames(): string[] {
  return [...KEY_PATTERNS.map((p) => p.name), 'credit-card']
}

// ─── Per-event payload filtering ──────────────────────────────────
//
// `applyPrivacy(payload, level)` is the single integration point
// between the privacy module and `hook.ts`. It runs once per event,
// in the user's hook subprocess, BEFORE the Voight client posts to
// `/v1/events`. The operator (the Voight backend) never sees the
// raw payload under Minimal or Standard.
//
// Strategy by level:
//   - full     → return the payload unchanged, only stamp
//                metadata.privacyLevel = 'full' so the dashboard
//                can label it.
//   - standard → walk every string leaf in `reasoning`,
//                `errorMessage`, `input.*`, and `metadata.*` and
//                run `scrubPii` over each. Numeric leaves
//                (`durationMs`, `tokens`, `tokensBreakdown.*`,
//                `timestamp`, `model` is a string but is a tag not
//                content, so we still scrub it but it never matches
//                anything) pass through unchanged. Token counts
//                and USD billing data are NUMERIC — they're never
//                redacted.
//   - minimal  → drop every field that can carry user content. We
//                build the output from an explicit allowlist instead
//                of a denylist so a future field added to mapEvent
//                can't accidentally leak.
//
// `applyPrivacy` is pure and idempotent. Re-running it on its own
// output produces the same payload (`privacyLevel` stamp re-applied
// identically; scrubs are stable once redacted).

/**
 * Recursively scrub every string leaf in a JSON-like value.
 * Non-string primitives (number, boolean, null), undefined, arrays,
 * and plain objects are walked structurally. Anything else (e.g.
 * a Date) is returned unchanged — the SDK never serialises those.
 */
export function scrubAnyValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubPii(value)
  if (Array.isArray(value)) return value.map(scrubAnyValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubAnyValue(v)
    }
    return out
  }
  return value
}

/**
 * Fields kept under Minimal mode. Values are taken from the event's
 * top-level `LogInput` (numbers + tool name + token counts) and
 * the `metadata` blob (allowlisted keys only).
 *
 * Anything not in either list is dropped.
 */
const MINIMAL_TOP_LEVEL: ReadonlyArray<keyof LogInput> = [
  'type',
  'toolExecuted',
  'outcome',
  'durationMs',
  'tokens',
  'model',
  'traceId',
  'timestamp',
  'transaction',
  'amount',
] as const

const MINIMAL_METADATA_KEYS: readonly string[] = [
  // Identity / routing — UUIDs and tags, no user content.
  'source',
  'framework',
  'tool',
  'hookEvent',
  'sessionId',
  'traceId',
  'phase',
  'promptSource',
  // Numerics + non-content metadata.
  'tokens',
  'tokensBreakdown',
  'model',
  'stopReason',
  'prompt_length',
] as const

export function applyPrivacy(
  input: LogInput,
  level: PrivacyLevel,
): LogInput {
  if (level === 'full') {
    return {
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        privacyLevel: 'full',
      },
    }
  }

  if (level === 'minimal') {
    const sourceMeta = (input.metadata ?? {}) as Record<string, unknown>
    const filteredMeta: Record<string, unknown> = {}
    for (const k of MINIMAL_METADATA_KEYS) {
      if (k in sourceMeta) filteredMeta[k] = sourceMeta[k]
    }
    // Keep an error-class signal without the raw message body. The
    // dashboard's outcome chip is enough — UI can show "failed" without
    // any text.
    filteredMeta.privacyLevel = 'minimal'

    const out: LogInput = {
      metadata: filteredMeta,
    }
    for (const key of MINIMAL_TOP_LEVEL) {
      const v = input[key]
      if (v !== undefined) {
        // Indexed assignment via `as any` so we don't lose generic
        // narrowing per key — each value retains its declared type
        // because we only copy from input.
        ;(out as Record<string, unknown>)[key] = v
      }
    }
    return out
  }

  // standard: scrub every string leaf, preserve everything else.
  const scrubbedMeta = (
    input.metadata
      ? (scrubAnyValue(input.metadata) as Record<string, unknown>)
      : {}
  )
  scrubbedMeta.privacyLevel = 'standard'

  const out: LogInput = {
    ...input,
    reasoning:
      typeof input.reasoning === 'string'
        ? scrubPii(input.reasoning)
        : input.reasoning,
    errorMessage:
      typeof input.errorMessage === 'string'
        ? scrubPii(input.errorMessage)
        : input.errorMessage,
    input: input.input
      ? (scrubAnyValue(input.input) as LogInput['input'])
      : input.input,
    metadata: scrubbedMeta,
  }
  return out
}
