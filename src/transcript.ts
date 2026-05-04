/**
 * Token capture from Claude Code's transcript file.
 *
 * Each hook event includes `transcript_path` pointing to the local
 * `.jsonl` file Claude Code maintains for the session. Each line is
 * one message, and every assistant message includes `usage` with the
 * actual input/output token counts from Anthropic's response — i.e.
 * the *real* cost driver for a Claude Code session.
 *
 * Why this matters:
 *   - PostToolUse hooks fire for every tool call, but most tools
 *     (Bash, Read, Edit, …) are local operations with no LLM activity
 *     and so no usage data attached. Only Task subagent calls expose
 *     tokens via tool_response.
 *   - Meanwhile the *main* Claude Code session is doing the bulk of
 *     the LLM work (reasoning between tool calls). That activity is
 *     invisible to the hook surface — but it's recorded in the
 *     transcript.
 *
 * Strategy:
 *   - On each PostToolUse, walk the transcript backward to find the
 *     assistant message whose `tool_use` content matches our current
 *     tool call (by tool_name + tool_input shape).
 *   - Extract usage + model from that message.
 *   - Dedup via tmpdir cache keyed by message uuid: if a single
 *     assistant message kicked off N tools, we attribute its tokens
 *     ONLY to the first tool that fingerprints it. The other N-1 send
 *     no tokens (zero-cost, doesn't double-count).
 *
 * Privacy: this reads the transcript locally and only ships token
 * COUNTS + model name to the Voight backend. No prompt content, no
 * tool inputs, no responses ever leave the user's machine via this
 * path. Disable entirely with VOIGHT_NO_TRANSCRIPT=1.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

const ATTRIBUTION_DIR = join(tmpdir(), 'voight-tokens')
const ATTRIBUTION_TTL_MS = 24 * 60 * 60_000 // 1 day — sessions can run long

export type TranscriptUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  model: string | null
}

type TranscriptMessage = {
  uuid?: string
  type?: string
  message?: {
    role?: string
    model?: string
    content?: Array<{
      type?: string
      name?: string
      input?: unknown
      id?: string
    }>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

type FindUsageDiag = {
  transcriptExists: boolean
  totalLines: number
  assistantMessages: number
  toolNameMatches: number
  exactInputMatches: number
  matched: 'exact' | 'lenient' | 'none'
  fallbackReason?: string
}

/**
 * Tail-read the transcript and find the most recent assistant message
 * whose tool_use matches the given (toolName, toolInput).
 *
 * Two-stage match (with the second as a robustness fallback):
 *   1. Exact: tool_name === toolName AND stable-stringified inputs match.
 *      This handles the common case cleanly.
 *   2. Lenient: tool_name === toolName, take the most recent. Real-world
 *      Claude Code occasionally surfaces tool_input shape differences
 *      between the hook stdin and the transcript-recorded tool_use
 *      (extra/missing fields, default normalization). Since the
 *      transcript is append-only and we walk backward, the most recent
 *      tool of this name IS the one that triggered the current hook.
 *      Dedup via message UUID still ensures usage is attributed once.
 *
 * Capped at the last 4MB of the file for very large transcripts.
 */
export function findUsageForTool(
  transcriptPath: string | undefined,
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): {
  uuid: string
  usage: TranscriptUsage
  diag: FindUsageDiag
} | null {
  const diag: FindUsageDiag = {
    transcriptExists: false,
    totalLines: 0,
    assistantMessages: 0,
    toolNameMatches: 0,
    exactInputMatches: 0,
    matched: 'none',
  }

  if (!transcriptPath || !toolName) {
    diag.fallbackReason = 'no transcriptPath or toolName'
    return diag.transcriptExists ? null : null
  }
  if (!existsSync(transcriptPath)) {
    diag.fallbackReason = `transcript not found: ${transcriptPath}`
    return null
  }
  diag.transcriptExists = true

  let raw: string
  try {
    const stats = statSync(transcriptPath)
    const maxBytes = 4 * 1024 * 1024
    if (stats.size > maxBytes) {
      // CRITICAL: must use top-level ESM imports here. Earlier
      // versions called `require('node:fs').openSync` which becomes
      // `__require("fs").openSync` after esbuild and silently fails
      // in pure-ESM runtimes — leaving long-running sessions (>4MB
      // transcripts) without any token capture.
      const buf = Buffer.alloc(maxBytes)
      const fd = openSync(transcriptPath, 'r')
      try {
        readSync(fd, buf, 0, maxBytes, stats.size - maxBytes)
      } finally {
        closeSync(fd)
      }
      raw = buf.toString('utf-8')
      const idx = raw.indexOf('\n')
      if (idx > 0) raw = raw.slice(idx + 1)
    } else {
      raw = readFileSync(transcriptPath, 'utf-8')
    }
  } catch (err) {
    diag.fallbackReason = `read failed: ${(err as Error).message}`
    return null
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  diag.totalLines = lines.length

  // Stage 1: exact match (tool_name + tool_input).
  // Stage 2: lenient match (tool_name only). Recorded as a fallback if
  //          stage 1 finds nothing.
  let lenientCandidate: {
    uuid: string
    usage: TranscriptUsage
  } | null = null

  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = safeParseJson(lines[i]!)
    if (!parsed) continue
    if (parsed.type !== 'assistant') continue
    const msg = parsed.message
    if (!msg || msg.role !== 'assistant') continue
    diag.assistantMessages++

    const content = Array.isArray(msg.content) ? msg.content : []
    const toolUses = content.filter(
      (c) => c && c.type === 'tool_use' && c.name === toolName,
    )
    if (toolUses.length === 0) continue
    diag.toolNameMatches++

    const usage = msg.usage
    if (!usage) continue
    const extracted: TranscriptUsage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      model: typeof msg.model === 'string' ? msg.model : null,
    }
    const uuid = parsed.uuid ?? `${transcriptPath}:${i}`

    // Stage 1: exact input match
    const exact = toolUses.find((c) => toolInputsMatch(c.input, toolInput))
    if (exact) {
      diag.exactInputMatches++
      diag.matched = 'exact'
      return { uuid, usage: extracted, diag }
    }

    // Remember the first (most recent) lenient candidate; we'll use it
    // only if no exact match shows up further back in the transcript.
    if (!lenientCandidate) {
      lenientCandidate = { uuid, usage: extracted }
    }
  }

  if (lenientCandidate) {
    diag.matched = 'lenient'
    diag.fallbackReason = 'no exact tool_input match — used most recent ' +
      `assistant message with tool_name=${toolName}`
    return { ...lenientCandidate, diag }
  }

  diag.fallbackReason = `no assistant message in transcript invokes ${toolName}`
  return null
}

function safeParseJson(s: string): TranscriptMessage | null {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? (v as TranscriptMessage) : null
  } catch {
    return null
  }
}

/**
 * Compare two tool_input objects for equality. Strict JSON.stringify
 * is too brittle (key order varies); we sort keys before comparing.
 */
function toolInputsMatch(a: unknown, b: unknown): boolean {
  try {
    return stableStringify(a) === stableStringify(b)
  } catch {
    return false
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`
}

// ─── Attribution dedup ───────────────────────────────────────────

/**
 * Mark this assistant message's tokens as already attributed. Returns
 * true if the caller is the FIRST to attribute (and should ship the
 * tokens), false if someone already did (and the caller should ship
 * zero tokens to avoid double-counting).
 *
 * Each assistant message can spawn N tool calls — we only want the
 * usage to land once.
 */
export function claimAttribution(uuid: string): boolean {
  const path = join(ATTRIBUTION_DIR, `${safeFilename(uuid)}.txt`)
  try {
    if (existsSync(path)) return false
    mkdirSync(ATTRIBUTION_DIR, { recursive: true })
    // O_EXCL semantics: writeFileSync with no flag will overwrite,
    // which is technically a race. For our use case (one local user
    // running one Claude Code session), races are vanishingly rare and
    // the cost of an occasional double-attribution is one extra
    // (small) data point — not catastrophic.
    writeFileSync(path, String(Date.now()))
    return true
  } catch {
    return false
  }
}

/**
 * Probabilistic GC of stale attribution markers. Runs on ~5% of hook
 * invocations to avoid filesystem clutter.
 */
export function gcAttributionDir(): void {
  if (Math.random() > 0.05) return
  try {
    if (!existsSync(ATTRIBUTION_DIR)) return
    const now = Date.now()
    for (const f of readdirSync(ATTRIBUTION_DIR)) {
      const p = join(ATTRIBUTION_DIR, f)
      try {
        const st = statSync(p)
        if (now - st.mtimeMs > ATTRIBUTION_TTL_MS) unlinkSync(p)
      } catch {
        /* ignore individual failures */
      }
    }
  } catch {
    /* ignore */
  }
}

function safeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

// ─── Final response capture (Stop event) ─────────────────────────

export type FinalResponse = {
  /** Plain-text portion of the assistant's last message. Truncated. */
  responseText?: string
  /** Why the turn ended: 'end_turn' | 'max_tokens' | 'tool_use' | ... */
  stopReason?: string
  /** Last thinking block content (if extended thinking was on). Truncated. */
  thinkingPreview?: string
}

export type FindResponseOptions = {
  /** Default 2000. Set to 0 to skip text capture. */
  maxTextLength?: number
  /** Default 800. Set to 0 to skip thinking capture. */
  maxThinkingLength?: number
  /** Default true. Pass false to skip text entirely. */
  captureText?: boolean
  /** Default true. Pass false to skip thinking entirely. */
  captureThinking?: boolean
}

/**
 * Walk the transcript backward to find the assistant's last turn and
 * extract its final text, stop_reason, and any thinking block.
 *
 * Returns null when the transcript file doesn't exist or is unreadable.
 * Returns an empty object {} when the file exists but has no assistant
 * messages (caller should treat that as "trace had no agent reply").
 */
export function findResponseForSession(
  transcriptPath: string | undefined,
  options: FindResponseOptions = {},
): FinalResponse | null {
  if (!transcriptPath) return null
  if (!existsSync(transcriptPath)) return null

  const maxTextLength = options.maxTextLength ?? 2000
  const maxThinkingLength = options.maxThinkingLength ?? 800
  const captureText = options.captureText ?? true
  const captureThinking = options.captureThinking ?? true

  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf-8')
  } catch {
    return null
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return {}

  // Walk backward looking for the last assistant message.
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: TranscriptMessage | null
    try {
      const v = JSON.parse(lines[i]!)
      parsed = v && typeof v === 'object' ? (v as TranscriptMessage) : null
    } catch {
      continue
    }
    if (!parsed || parsed.type !== 'assistant') continue
    const msg = parsed.message
    if (!msg || msg.role !== 'assistant') continue

    const result: FinalResponse = {}

    // stop_reason lives directly on the message envelope
    const stopReason = (msg as Record<string, unknown>).stop_reason
    if (typeof stopReason === 'string') result.stopReason = stopReason

    const content = Array.isArray(msg.content) ? msg.content : []

    if (captureText) {
      // Concatenate every text block in order — Claude sometimes
      // emits multiple text blocks per turn (split around tool_use).
      const textParts: string[] = []
      for (const c of content) {
        if (c && c.type === 'text') {
          const t = (c as Record<string, unknown>).text
          if (typeof t === 'string' && t.length > 0) textParts.push(t)
        }
      }
      if (textParts.length > 0) {
        const joined = textParts.join('\n\n')
        result.responseText =
          joined.length > maxTextLength
            ? joined.slice(0, maxTextLength) + '…'
            : joined
      }
    }

    if (captureThinking) {
      // Pick the LAST thinking block in the turn — represents the
      // assistant's most recent reasoning. Earlier ones are usually
      // intermediate steps.
      let lastThinking: string | undefined
      for (const c of content) {
        if (c && c.type === 'thinking') {
          const t = (c as Record<string, unknown>).thinking
          if (typeof t === 'string' && t.length > 0) lastThinking = t
        }
      }
      if (lastThinking !== undefined) {
        result.thinkingPreview =
          lastThinking.length > maxThinkingLength
            ? lastThinking.slice(0, maxThinkingLength) + '…'
            : lastThinking
      }
    }

    return result
  }

  return {}
}
