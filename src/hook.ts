/**
 * `voight hook` — invoked by Claude Code's settings.json hooks.
 *
 * Claude Code feeds the hook a JSON object on stdin:
 *   {
 *     hook_event_name: "PreToolUse" | "PostToolUse" | "UserPromptSubmit"
 *                    | "Stop" | "SubagentStop" | "Notification" | "PreCompact",
 *     session_id: string,
 *     cwd: string,
 *     transcript_path: string,
 *     tool_name?: string,
 *     tool_input?: object,
 *     tool_response?: object,
 *     prompt?: string,
 *     message?: string,
 *     reason?: string,
 *     ...
 *   }
 *
 * What this file does (Fase A — enriched capture):
 *   1. Maps every supported hook event into a Voight event payload.
 *   2. Extracts a per-tool "detail" from tool_input so the dashboard
 *      can show "Bash $ ls -la /tmp" instead of "about to call Bash".
 *   3. Tracks Pre→Post duration via a tiny on-disk cache in tmpdir
 *      keyed by session_id + tool_name + tool_input hash.
 *   4. Computes outcome (success / failed) from tool_response.error and
 *      forwards token usage + error message when present.
 *
 * Critical contract: never crash the host editor. Hooks failing fast
 * is fine; hooks raising stack traces in the user's terminal is not.
 * We log diagnostics on stderr only when DEBUG=1.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'

import { Voight } from './index.js'
import type { LogInput } from './index.js'
import {
  claimAttribution,
  findUsageForTool,
  gcAttributionDir,
} from './transcript.js'

type HookEvent = {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  transcript_path?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: Record<string, unknown>
  prompt?: string
  message?: string
  reason?: string
  trigger?: string
  custom_instructions?: string
}

const DEBUG = process.env.VOIGHT_DEBUG === '1' || process.env.DEBUG === '1'

function dbg(...args: unknown[]) {
  if (DEBUG) console.error('[voight-hook]', ...args)
}

/**
 * Diagnostic log to a file. Only active when VOIGHT_DEBUG_FILE is set
 * (e.g. VOIGHT_DEBUG_FILE=/tmp/voight-hook.log). Lets us see what's
 * happening inside the hook subprocess from the user's terminal
 * without polluting Claude Code's stderr.
 *
 * Each call appends one JSON line with a timestamp + label + payload.
 */
function debugLog(label: string, payload: unknown): void {
  const path = process.env.VOIGHT_DEBUG_FILE
  if (!path) return
  try {
    const entry =
      JSON.stringify({
        ts: new Date().toISOString(),
        label,
        payload,
      }) + '\n'
    appendFileSync(path, entry)
  } catch {
    // never throw from a hook
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function safeParse(raw: string): HookEvent | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

// --- Trace ID per session -----------------------------------------------
// Each user prompt starts a new "trace" — all subsequent events until
// the next prompt share that traceId so the dashboard can group "the
// agent's full response to my question" as one logical operation.
//
// Persisted in tmpdir keyed by session_id so the value survives across
// the short-lived hook subprocesses Claude Code spawns.

const TRACE_DIR = join(tmpdir(), 'voight-traces')

function traceFile(sessionId: string | undefined): string {
  return join(TRACE_DIR, `${(sessionId ?? 'unknown').slice(0, 64)}.txt`)
}

function setTraceId(sessionId: string | undefined, traceId: string): void {
  try {
    mkdirSync(TRACE_DIR, { recursive: true })
    writeFileSync(traceFile(sessionId), traceId)
  } catch (err) {
    dbg('trace write failed:', (err as Error).message)
  }
}

function getTraceId(sessionId: string | undefined): string | undefined {
  try {
    const path = traceFile(sessionId)
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf-8').trim() || undefined
  } catch {
    return undefined
  }
}

function newTraceId(): string {
  // 12 hex chars from timestamp + random — short, copy-paste friendly,
  // and enough entropy to be unique across one user's sessions.
  const ts = Date.now().toString(36)
  const rand = createHash('sha256')
    .update(`${Date.now()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 8)
  return `t_${ts}_${rand}`
}

// --- Pre→Post duration cache --------------------------------------------
// Each hook invocation is a short-lived process, so we persist the
// PreToolUse timestamp to tmpdir and consume it from PostToolUse.

const CACHE_DIR = join(tmpdir(), 'voight-hooks')
const CACHE_TTL_MS = 60 * 60 * 1000 // 1h

function safeStringifyForKey(v: unknown): string {
  try {
    return JSON.stringify(v ?? null)
  } catch {
    return String(v)
  }
}

function durationKey(
  sessionId: string | undefined,
  toolName: string | undefined,
  toolInput: unknown,
): string {
  const h = createHash('sha256')
  h.update(sessionId ?? '')
  h.update('|')
  h.update(toolName ?? '')
  h.update('|')
  h.update(safeStringifyForKey(toolInput))
  return h.digest('hex').slice(0, 16)
}

function rememberStart(key: string, ts: number): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify({ ts }))
  } catch (err) {
    dbg('cache write failed:', (err as Error).message)
  }
}

function consumeStart(key: string): number | null {
  const path = join(CACHE_DIR, `${key}.json`)
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { ts?: unknown }
    try {
      unlinkSync(path)
    } catch {
      /* ignore */
    }
    return typeof raw.ts === 'number' ? raw.ts : null
  } catch {
    return null
  }
}

function gcCacheOnce(): void {
  // Cheap probabilistic GC: 5% of invocations sweep stale entries.
  if (Math.random() > 0.05) return
  try {
    if (!existsSync(CACHE_DIR)) return
    const now = Date.now()
    for (const f of readdirSync(CACHE_DIR)) {
      const p = join(CACHE_DIR, f)
      try {
        const st = statSync(p)
        if (now - st.mtimeMs > CACHE_TTL_MS) unlinkSync(p)
      } catch {
        /* ignore individual failures */
      }
    }
  } catch {
    /* ignore */
  }
}

// --- Per-tool detail extractor ------------------------------------------

type ToolDetail = {
  /** Single-line human summary. Goes into reasoning + dashboard "Detail" column. */
  summary: string
  /** Structured fields for the side-panel JSON view. */
  structured: Record<string, unknown>
}

function shortenPath(p: string, max = 60): string {
  if (!p) return p
  if (p.length <= max) return p
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 3) return p
  return `…/${parts.slice(-3).join('/')}`
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function truncate(s: string | undefined, n: number): string | undefined {
  if (typeof s !== 'string') return undefined
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function extractToolDetail(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): ToolDetail {
  const name = toolName ?? 'tool'
  const i = toolInput ?? {}

  switch (toolName) {
    case 'Bash': {
      const command = asString(i.command)
      const description = asString(i.description)
      return {
        summary: command ? `$ ${truncate(command, 200)}` : 'Bash',
        structured: {
          command,
          description,
          timeout: i.timeout,
          run_in_background: i.run_in_background === true,
        },
      }
    }
    case 'Read': {
      const filePath = asString(i.file_path)
      return {
        summary: filePath ? `Read ${shortenPath(filePath)}` : 'Read',
        structured: {
          file_path: filePath,
          offset: i.offset,
          limit: i.limit,
          pages: i.pages,
        },
      }
    }
    case 'Edit': {
      const filePath = asString(i.file_path)
      const oldStr = asString(i.old_string) ?? ''
      const newStr = asString(i.new_string) ?? ''
      const replaceAll = i.replace_all === true
      return {
        summary: filePath
          ? `Edit ${shortenPath(filePath)} (-${oldStr.length}/+${newStr.length})`
          : 'Edit',
        structured: {
          file_path: filePath,
          old_length: oldStr.length,
          new_length: newStr.length,
          replace_all: replaceAll,
        },
      }
    }
    case 'Write': {
      const filePath = asString(i.file_path)
      const content = asString(i.content) ?? ''
      return {
        summary: filePath
          ? `Write ${shortenPath(filePath)} (${content.length}b)`
          : 'Write',
        structured: { file_path: filePath, content_length: content.length },
      }
    }
    case 'Grep': {
      const pattern = asString(i.pattern)
      const path = asString(i.path)
      const summary = pattern
        ? `Grep ${truncate(pattern, 80)}${path ? ` in ${shortenPath(path)}` : ''}`
        : 'Grep'
      return {
        summary,
        structured: {
          pattern,
          path,
          glob: i.glob,
          type: i.type,
          output_mode: i.output_mode,
          case_insensitive: i['-i'] === true,
          show_line_numbers: i['-n'] === true,
        },
      }
    }
    case 'Glob': {
      const pattern = asString(i.pattern)
      const path = asString(i.path)
      return {
        summary: pattern
          ? `Glob ${pattern}${path ? ` in ${shortenPath(path)}` : ''}`
          : 'Glob',
        structured: { pattern, path },
      }
    }
    case 'WebFetch': {
      const url = asString(i.url)
      const prompt = asString(i.prompt)
      return {
        summary: url ? `Fetch ${truncate(url, 120)}` : 'WebFetch',
        structured: { url, prompt: truncate(prompt, 200) },
      }
    }
    case 'WebSearch': {
      const query = asString(i.query)
      return {
        summary: query ? `Search "${truncate(query, 120)}"` : 'WebSearch',
        structured: {
          query,
          allowed_domains: i.allowed_domains,
          blocked_domains: i.blocked_domains,
        },
      }
    }
    case 'Task':
    case 'Agent': {
      const subagentType = asString(i.subagent_type)
      const description = asString(i.description)
      const prompt = asString(i.prompt) ?? ''
      const summary = description
        ? `Task: ${truncate(description, 120)}`
        : `Task${subagentType ? ` (${subagentType})` : ''}`
      return {
        summary,
        structured: {
          subagent_type: subagentType,
          description,
          prompt_preview: truncate(prompt, 240),
          prompt_length: prompt.length,
          model: asString(i.model),
        },
      }
    }
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? (i.todos as unknown[]) : []
      const counts: Record<string, number> = {}
      for (const t of todos) {
        const status =
          typeof (t as { status?: unknown })?.status === 'string'
            ? ((t as { status: string }).status as string)
            : 'unknown'
        counts[status] = (counts[status] ?? 0) + 1
      }
      const breakdown = Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')
      return {
        summary: `TodoWrite ${todos.length} todos${breakdown ? ` (${breakdown})` : ''}`,
        structured: {
          todo_count: todos.length,
          status_counts: counts,
          todos: todos.slice(0, 30),
        },
      }
    }
    case 'NotebookEdit': {
      const path = asString(i.notebook_path)
      const mode = asString(i.edit_mode) ?? 'edit'
      return {
        summary: path
          ? `Notebook ${shortenPath(path)} (${mode})`
          : 'NotebookEdit',
        structured: {
          notebook_path: path,
          edit_mode: mode,
          cell_id: asString(i.cell_id),
          cell_type: asString(i.cell_type),
        },
      }
    }
    default: {
      // Generic: try to find a path-like or query-like field.
      const guess =
        asString(i.file_path) ??
        asString(i.path) ??
        asString(i.url) ??
        asString(i.query)
      return {
        summary: guess ? `${name} ${shortenPath(guess)}` : name,
        structured: { tool_input_keys: Object.keys(i) },
      }
    }
  }
}

// --- Response inspection -----------------------------------------------

function detectFailure(tr: Record<string, unknown> | undefined): {
  failed: boolean
  errorMessage?: string
} {
  if (!tr) return { failed: false }
  const directError =
    typeof tr.error === 'string'
      ? tr.error
      : typeof tr.error === 'object' && tr.error
        ? safeStringifyForKey(tr.error)
        : undefined
  if (directError) return { failed: true, errorMessage: directError }

  if (tr.is_error === true) {
    const msg =
      typeof tr.message === 'string'
        ? tr.message
        : typeof tr.error_message === 'string'
          ? (tr.error_message as string)
          : 'tool reported is_error=true'
    return { failed: true, errorMessage: msg }
  }
  if (tr.success === false) {
    const msg =
      typeof tr.message === 'string'
        ? tr.message
        : 'tool reported success=false'
    return { failed: true, errorMessage: msg }
  }
  return { failed: false }
}

function extractTokens(
  tr: Record<string, unknown> | undefined,
): { input?: number; output?: number; total?: number } | undefined {
  if (!tr) return undefined
  const usage = (tr.usage ?? tr.token_usage ?? tr.tokens) as
    | Record<string, unknown>
    | undefined
  if (!usage || typeof usage !== 'object') return undefined
  const num = (k: string): number | undefined => {
    const v = usage[k]
    return typeof v === 'number' ? v : undefined
  }
  const tokens = {
    input: num('input') ?? num('input_tokens') ?? num('prompt_tokens'),
    output:
      num('output') ?? num('output_tokens') ?? num('completion_tokens'),
    total: num('total') ?? num('total_tokens'),
  }
  if (
    tokens.input === undefined &&
    tokens.output === undefined &&
    tokens.total === undefined
  ) {
    return undefined
  }
  return tokens
}

function responsePreview(
  tr: Record<string, unknown> | undefined,
  limit = 600,
): string | undefined {
  if (!tr) return undefined
  try {
    const s = JSON.stringify(tr)
    return s.length > limit ? `${s.slice(0, limit)}…` : s
  } catch {
    return undefined
  }
}

// --- Mapping ------------------------------------------------------------

function mapEvent(evt: HookEvent): LogInput & { reasoning: string } {
  const event = evt.hook_event_name ?? 'unknown'

  // Trace ID lifecycle: UserPromptSubmit starts a new trace; everything
  // until the next prompt inherits it. Stop / SubagentStop also rotate
  // since the agent is "done" with whatever it was doing.
  let traceId: string | undefined
  if (event === 'UserPromptSubmit') {
    traceId = newTraceId()
    setTraceId(evt.session_id, traceId)
  } else {
    traceId = getTraceId(evt.session_id)
  }

  const baseMeta: Record<string, unknown> = {
    source: 'claude-code',
    hookEvent: event,
    sessionId: evt.session_id,
    cwd: evt.cwd,
    ...(traceId ? { traceId } : {}),
  }

  switch (event) {
    case 'PreToolUse': {
      const detail = extractToolDetail(evt.tool_name, evt.tool_input)
      const key = durationKey(evt.session_id, evt.tool_name, evt.tool_input)
      rememberStart(key, Date.now())
      return {
        type: 'action',
        toolExecuted: evt.tool_name,
        reasoning: `→ ${detail.summary}`,
        outcome: 'pending',
        metadata: {
          ...baseMeta,
          phase: 'pre',
          detail: detail.structured,
        },
      }
    }
    case 'PostToolUse': {
      const detail = extractToolDetail(evt.tool_name, evt.tool_input)
      const tr = evt.tool_response
      const { failed, errorMessage } = detectFailure(tr)
      const responseTokens = extractTokens(tr)

      const key = durationKey(evt.session_id, evt.tool_name, evt.tool_input)
      const startedAt = consumeStart(key)
      const durationMs =
        typeof startedAt === 'number' ? Date.now() - startedAt : undefined

      const durationStr =
        durationMs !== undefined ? ` (${formatDuration(durationMs)})` : ''
      const prefix = failed ? '✗' : '✓'

      // Look up the assistant message that initiated this tool call
      // in the local transcript. That message's `usage` is the real
      // source of token counts for Claude Code sessions — most tools
      // (Bash, Read, Edit) don't return usage themselves. Disabled
      // when VOIGHT_NO_TRANSCRIPT=1.
      let transcriptTokens:
        | { input?: number; output?: number; total?: number }
        | undefined
      // Explicit breakdown for accurate backend pricing — Anthropic
      // bills cache_read at 0.10× and cache_creation at 1.25×, but the
      // flat tokens.input number conflates all three at the full rate.
      // When the SDK ships this, the backend's cost path bypasses the
      // 80%-cache heuristic and prices each flavour at its true rate.
      let tokensBreakdown:
        | {
            inputBase: number
            cacheCreation: number
            cacheRead: number
            output: number
          }
        | undefined
      let transcriptModel: string | undefined
      let transcriptMatchKind: 'exact' | 'lenient' | 'none' = 'none'
      if (process.env.VOIGHT_NO_TRANSCRIPT !== '1') {
        const found = findUsageForTool(
          evt.transcript_path,
          evt.tool_name,
          evt.tool_input,
        )
        debugLog('transcript lookup', {
          tool: evt.tool_name,
          transcript_path: evt.transcript_path,
          diag: found?.diag,
          foundUsage: found
            ? {
                input: found.usage.inputTokens,
                output: found.usage.outputTokens,
                model: found.usage.model,
              }
            : null,
        })
        if (found) {
          transcriptMatchKind = found.diag.matched
          if (claimAttribution(found.uuid)) {
            const u = found.usage
            const totalInput =
              u.inputTokens +
              (u.cacheCreationTokens ?? 0) +
              (u.cacheReadTokens ?? 0)
            transcriptTokens = {
              input: totalInput,
              output: u.outputTokens,
              total: totalInput + u.outputTokens,
            }
            tokensBreakdown = {
              inputBase: u.inputTokens,
              cacheCreation: u.cacheCreationTokens ?? 0,
              cacheRead: u.cacheReadTokens ?? 0,
              output: u.outputTokens,
            }
            if (u.model) transcriptModel = u.model
            debugLog('attributed', {
              uuid: found.uuid,
              tokens: transcriptTokens,
              breakdown: tokensBreakdown,
              model: transcriptModel,
            })
          } else {
            debugLog('skipped (already attributed)', { uuid: found.uuid })
          }
        }
      }

      // Prefer transcript tokens (real LLM usage) over tool_response
      // tokens (subagent only). Both shouldn't normally co-exist.
      const tokens = transcriptTokens ?? responseTokens

      return {
        type: failed ? 'error' : 'action',
        toolExecuted: evt.tool_name,
        reasoning: `${prefix} ${detail.summary}${durationStr}`,
        outcome: failed ? 'failed' : 'success',
        durationMs,
        errorMessage,
        tokens,
        model: transcriptModel,
        metadata: {
          ...baseMeta,
          phase: 'post',
          detail: detail.structured,
          response_preview: responsePreview(tr),
          ...(tokens ? { tokens } : {}),
          ...(tokensBreakdown ? { tokensBreakdown } : {}),
          ...(transcriptModel ? { model: transcriptModel } : {}),
        },
      }
    }
    case 'UserPromptSubmit': {
      const prompt = evt.prompt ?? ''
      const preview = truncate(prompt, 800)
      return {
        type: 'decision',
        reasoning: preview ?? 'user prompt',
        outcome: 'success',
        input: { prompt: preview },
        metadata: {
          ...baseMeta,
          prompt_length: prompt.length,
        },
      }
    }
    case 'Stop': {
      return {
        type: 'decision',
        reasoning: 'session stopped',
        outcome: 'success',
        metadata: {
          ...baseMeta,
          reason: evt.reason ?? null,
        },
      }
    }
    case 'SubagentStop': {
      return {
        type: 'decision',
        reasoning: 'subagent finished',
        outcome: 'success',
        metadata: {
          ...baseMeta,
          reason: evt.reason ?? null,
        },
      }
    }
    case 'Notification': {
      const msg = evt.message ?? 'notification'
      return {
        type: 'decision',
        reasoning: `notify: ${truncate(msg, 200)}`,
        outcome: 'success',
        metadata: {
          ...baseMeta,
          message: msg,
        },
      }
    }
    case 'PreCompact': {
      return {
        type: 'decision',
        reasoning: `compacting context${evt.trigger ? ` (${evt.trigger})` : ''}`,
        outcome: 'success',
        metadata: {
          ...baseMeta,
          trigger: evt.trigger ?? null,
          custom_instructions: truncate(evt.custom_instructions, 400),
        },
      }
    }
    default: {
      return {
        type: 'decision',
        reasoning: evt.message ?? event,
        outcome: 'success',
        metadata: baseMeta,
      }
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

// --- Entry --------------------------------------------------------------

export async function runHook(): Promise<void> {
  gcCacheOnce()
  gcAttributionDir()

  const apiKey = process.env.VOIGHT_KEY
  if (!apiKey) {
    dbg('VOIGHT_KEY missing — skipping')
    return
  }

  const raw = await readStdin()
  if (!raw) {
    dbg('no stdin')
    return
  }

  const evt = safeParse(raw)
  if (!evt) {
    dbg('non-JSON stdin')
    return
  }

  // Use the working directory the hook is firing in as a stable
  // agent identifier. Falls back to the session id, then to a generic
  // bucket. Users can override with VOIGHT_AGENT_ID.
  const agentId =
    process.env.VOIGHT_AGENT_ID ||
    (evt.cwd ? `claude-code:${pathBasename(evt.cwd)}` : null) ||
    (evt.session_id ? `claude-code:${evt.session_id.slice(0, 8)}` : null) ||
    'claude-code:unknown'

  const endpoint =
    process.env.VOIGHT_ENDPOINT ||
    process.env.NEXT_PUBLIC_VOIGHT_API ||
    undefined

  const voight = new Voight({
    agentId,
    apiKey,
    endpoint,
    swallowErrors: true,
    defaults: { tool: 'claude-code' },
  })

  const mapped = mapEvent(evt)
  // Lift traceId from metadata to the top-level LogInput field so the
  // Voight client can ship it as a first-class column when the
  // backend gains a dedicated `traceId` field. Today it's also in
  // metadata.traceId so the dashboard already groups by it.
  const traceId =
    typeof (mapped.metadata as Record<string, unknown> | undefined)?.traceId ===
    'string'
      ? ((mapped.metadata as Record<string, unknown>).traceId as string)
      : undefined
  const res = await voight.log({ ...mapped, traceId })
  if (!res.ok) dbg('log failed:', res.error)
  else dbg('logged event', res.eventId)
}

function pathBasename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}
