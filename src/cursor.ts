/**
 * Cursor adapter — translates Cursor's hook events into Voight's
 * `LogInput` shape. Lives in its own module to keep hook.ts focused
 * on Claude Code's flow (its original target) and to make the Cursor
 * pieces testable in isolation.
 *
 * Cursor's hook payloads are documented in
 *   ~/.cursor/skills-cursor/create-hook/SKILL.md
 * and were empirically validated against a 30-event capture from
 * Cursor 3.4.17. See voight-progress-context for the probe history.
 *
 * Mapping summary (Cursor → Voight):
 *   sessionStart        → decision  (session marker)
 *   beforeSubmitPrompt  → decision  (input.prompt)
 *   preToolUse          → action    (outcome: pending)
 *   postToolUse         → action    (outcome: success / failed, durationMs)
 *   afterAgentResponse  → decision  (text + tokens + model)
 *   stop                → decision  (status, tokens, model)
 *
 * Trace identity: Cursor exposes `generation_id` natively. Every
 * event in the same generation shares it, so we lift it to
 * `traceId` directly — no on-disk trace file needed (the equivalent
 * of Claude Code's `voight-traces/<sessionId>` cache).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LogInput } from './index.js'

/** Cursor hook event names — camelCase, distinct from Claude Code. */
export type CursorEventName =
  | 'sessionStart'
  | 'beforeSubmitPrompt'
  | 'preToolUse'
  | 'postToolUse'
  | 'postToolUseFailure'
  | 'afterAgentResponse'
  | 'afterAgentThought'
  | 'subagentStart'
  | 'subagentStop'
  | 'preCompact'
  | 'stop'

/**
 * Loose type — every field optional because Cursor emits different
 * subsets per event. Field names match Cursor's wire format
 * verbatim (snake_case).
 */
export type CursorEvent = {
  hook_event_name?: string
  cursor_version?: string
  session_id?: string
  conversation_id?: string
  generation_id?: string
  model?: string
  workspace_roots?: string[]
  user_email?: string
  transcript_path?: string | null

  // beforeSubmitPrompt + sessionStart
  prompt?: string
  composer_mode?: string
  attachments?: unknown[]
  is_background_agent?: boolean

  // pre/postToolUse
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_output?: string
  tool_use_id?: string
  duration?: number
  cwd?: string

  // afterAgentResponse
  text?: string

  // stop
  status?: string
  loop_count?: number

  // afterAgentResponse + stop
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number

  // afterAgentThought — best-effort field names until probe captures one.
  thought?: string

  // subagentStart / subagentStop — best-effort until probe captures one.
  subagent_type?: string
  subagent_input?: Record<string, unknown>
  subagent_output?: unknown
  parent_session_id?: string

  // preCompact — best-effort. Cursor may surface token thresholds.
  trigger?: string
}

/**
 * Discriminator: distinguishes Cursor events from Claude Code's.
 * Claude Code's payloads never include `cursor_version`; Cursor's
 * always do (validated across all 6 event types in the probe).
 */
export function isCursorEvent(evt: Record<string, unknown>): boolean {
  return typeof evt.cursor_version === 'string'
}

/**
 * Resolve an agent identifier for a Cursor event. Priority:
 *   1. VOIGHT_AGENT_ID env override.
 *   2. `.voight-agent-id` marker in workspace_roots[0] (CUID written
 *      by the server after the first event matches by primary key
 *      thereafter — survives rename / move).
 *   3. `cursor:<workspace-basename>` legacy label for first-time runs.
 *   4. `cursor:<session-slice>` when there's no workspace root at all.
 *   5. `cursor:unknown` last resort.
 *
 * Returns both the chosen id and the marker path the caller can
 * write to once the server returns the canonical CUID.
 */
export function cursorAgentIdentity(
  evt: CursorEvent,
  env: NodeJS.ProcessEnv = process.env,
): { agentId: string; markerPath: string | null } {
  const envOverride = env.VOIGHT_AGENT_ID
  const root =
    Array.isArray(evt.workspace_roots) && evt.workspace_roots.length > 0
      ? evt.workspace_roots[0]
      : undefined
  const markerPath = root ? join(root, '.voight-agent-id') : null

  if (envOverride) return { agentId: envOverride, markerPath }

  if (markerPath && existsSync(markerPath)) {
    try {
      const cuid = readFileSync(markerPath, 'utf-8').trim()
      if (cuid) return { agentId: cuid, markerPath }
    } catch {
      /* unreadable marker — fall through */
    }
  }

  if (root) {
    return { agentId: `cursor:${basename(root)}`, markerPath }
  }
  if (evt.session_id) {
    return {
      agentId: `cursor:${evt.session_id.slice(0, 8)}`,
      markerPath: null,
    }
  }
  return { agentId: 'cursor:unknown', markerPath: null }
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * Normalise Cursor's `model` field for the dashboard.
 *
 * When the user is on Cursor Auto, Cursor routes the query to one
 * of several underlying models and reports `model: "default"` for
 * every event — its own SQLite tracking db has the same string, so
 * there's no way to recover the real model name post-hoc.
 *
 * Rather than send a meaningless `"default"` (which the backend
 * silently falls back to Sonnet 4.5 pricing for), we relabel to
 * `"cursor-auto"` so the dashboard renders something honest and the
 * pricing table can carry an explicit (estimated) entry for it.
 *
 * Concrete model names that Cursor reports (e.g.
 * `"claude-opus-4-7-thinking-xhigh"`) are passed through unchanged.
 */
export function normaliseCursorModel(model: string | undefined): string | undefined {
  if (!model) return model
  if (model === 'default' || model === 'auto') return 'cursor-auto'
  return model
}

/**
 * Truncate a string to N chars, appending an ellipsis when it
 * actually had to be cut. Pure; mirrors the helper used in
 * hook.ts for Claude Code's prompt previews so both adapters
 * surface the same shape to the dashboard.
 */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

/**
 * Translate Cursor's token usage breakdown to Voight's. Cursor's
 * shape is identical to Anthropic's native API counters:
 *   input_tokens         — fresh / uncached input
 *   cache_read_tokens    — served from cache (cheap)
 *   cache_write_tokens   — wrote to cache (premium)
 *   output_tokens        — generated output
 *
 * Voight's `tokens` field stores TOTAL counts; the per-flavour
 * breakdown lives in `metadata.tokensBreakdown` so backend pricing
 * can apply the correct multipliers per flavour (Path A pricing).
 */
export function cursorTokens(evt: CursorEvent): {
  tokens: { input?: number; output?: number; total?: number }
  breakdown: {
    inputBase?: number
    cacheRead?: number
    cacheCreation?: number
    output?: number
  }
} | null {
  const inputBase = evt.input_tokens
  const cacheRead = evt.cache_read_tokens
  const cacheCreation = evt.cache_write_tokens
  const output = evt.output_tokens
  if (
    inputBase === undefined &&
    cacheRead === undefined &&
    cacheCreation === undefined &&
    output === undefined
  ) {
    return null
  }
  const totalInput =
    (inputBase ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0)
  return {
    tokens: {
      input: totalInput || undefined,
      output: output,
      total:
        (totalInput || 0) + (output ?? 0) || undefined,
    },
    breakdown: {
      inputBase,
      cacheRead,
      cacheCreation,
      output,
    },
  }
}

/**
 * Parse Cursor's `tool_output` field — a JSON-encoded string the
 * postToolUse hook receives — into structured data the dashboard
 * can render. Returns `{ outcome, errorMessage? }` for tool calls.
 *
 * Cursor encodes failures as `{ ..., exitCode: <nonzero> }` for
 * Shell tools and `{ success: false, error: "..." }` for everything
 * else. We accept both shapes.
 */
export function parseCursorToolOutput(raw: string | undefined): {
  outcome: 'success' | 'failed'
  errorMessage?: string
} {
  if (!raw) return { outcome: 'success' }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.exitCode === 'number' && parsed.exitCode !== 0) {
      const out = typeof parsed.output === 'string' ? parsed.output : ''
      return {
        outcome: 'failed',
        errorMessage: out.slice(0, 200) || `exit ${parsed.exitCode}`,
      }
    }
    if (parsed.success === false) {
      return {
        outcome: 'failed',
        errorMessage:
          typeof parsed.error === 'string' ? parsed.error : 'failed',
      }
    }
    return { outcome: 'success' }
  } catch {
    return { outcome: 'success' }
  }
}

/**
 * Map a Cursor hook event to Voight's `LogInput`.
 *
 * Returns `null` for events we deliberately skip (e.g. sessionStart
 * for backgrounded agents — keeps the dashboard timeline clean).
 */
export function mapCursorEvent(evt: CursorEvent): LogInput | null {
  const name = evt.hook_event_name as CursorEventName | undefined
  if (!name) return null

  const traceId = evt.generation_id || undefined
  // traceId must live BOTH at top-level (public LogInput field for
  // library callers) AND inside metadata (runHook lifts it from
  // there to ship as a first-class column — matches Claude Code's
  // mapEvent convention so the dashboard groups events consistently
  // regardless of which adapter produced them).
  const baseMetadata: Record<string, unknown> = {
    hookEvent: name,
    cursorVersion: evt.cursor_version,
    sessionId: evt.session_id,
    conversationId: evt.conversation_id,
    ...(traceId ? { traceId } : {}),
  }
  if (evt.workspace_roots && evt.workspace_roots.length > 0) {
    baseMetadata.cwd = evt.workspace_roots[0]
  }
  if (evt.user_email) baseMetadata.userEmail = evt.user_email
  if (evt.composer_mode) baseMetadata.composerMode = evt.composer_mode

  switch (name) {
    case 'sessionStart': {
      // Background agents fire sessionStart too — skip to avoid
      // flooding the timeline with empty sessions.
      if (evt.is_background_agent) return null
      return {
        type: 'decision',
        reasoning: 'Cursor session started',
        model: normaliseCursorModel(evt.model),
        traceId,
        metadata: { ...baseMetadata, kind: 'session_start' },
      }
    }

    case 'beforeSubmitPrompt': {
      // Match Claude Code's UserPromptSubmit shape so the dashboard's
      // trace cards render the prompt preview consistently across
      // adapters: reasoning carries the visible preview, input.prompt
      // carries the full text (subject to privacy scrub), and the
      // outcome marks the event as a completed user action.
      const prompt = evt.prompt ?? ''
      const preview = truncate(prompt, 800)
      return {
        type: 'decision',
        reasoning: preview || 'user prompt',
        outcome: 'success',
        input: { prompt: preview },
        model: normaliseCursorModel(evt.model),
        traceId,
        metadata: {
          ...baseMetadata,
          kind: 'user_prompt',
          promptSource: 'user',
          prompt_length: prompt.length,
        },
      }
    }

    case 'preToolUse': {
      return {
        type: 'action',
        toolExecuted: evt.tool_name,
        outcome: 'pending',
        model: normaliseCursorModel(evt.model),
        traceId,
        metadata: {
          ...baseMetadata,
          kind: 'pre_tool_use',
          toolUseId: evt.tool_use_id,
          toolInput: evt.tool_input,
        },
      }
    }

    case 'postToolUse': {
      const result = parseCursorToolOutput(evt.tool_output)
      return {
        type: 'action',
        toolExecuted: evt.tool_name,
        outcome: result.outcome,
        errorMessage: result.errorMessage,
        durationMs:
          typeof evt.duration === 'number' ? evt.duration : undefined,
        model: normaliseCursorModel(evt.model),
        traceId,
        metadata: {
          ...baseMetadata,
          kind: 'post_tool_use',
          toolUseId: evt.tool_use_id,
          toolInput: evt.tool_input,
        },
      }
    }

    case 'afterAgentResponse': {
      // Match Claude Code's Stop-event shape: the response text
      // lives in metadata.responseText (which the dashboard renders
      // as a maskable block with an eye toggle), NOT in reasoning.
      // Reasoning is a short marker so the trace timeline reads
      // "Agent response · click for details" instead of leaking the
      // full text inline. Privacy + visual parity with Claude in one
      // change.
      const tokens = cursorTokens(evt)
      const text = evt.text ?? ''
      return {
        type: 'decision',
        reasoning: 'agent response captured',
        outcome: 'success',
        model: normaliseCursorModel(evt.model),
        traceId,
        tokens: tokens?.tokens,
        metadata: {
          ...baseMetadata,
          kind: 'agent_response',
          ...(text ? { responseText: text } : {}),
          tokensBreakdown: tokens?.breakdown,
        },
      }
    }

    case 'stop': {
      const tokens = cursorTokens(evt)
      const isAborted = evt.status === 'aborted'
      return {
        type: 'decision',
        reasoning: isAborted ? 'Cursor turn aborted' : 'Cursor turn completed',
        outcome: isAborted ? 'failed' : 'success',
        model: normaliseCursorModel(evt.model),
        traceId,
        tokens: tokens?.tokens,
        metadata: {
          ...baseMetadata,
          kind: 'stop',
          status: evt.status,
          loopCount: evt.loop_count,
          tokensBreakdown: tokens?.breakdown,
        },
      }
    }

    case 'postToolUseFailure': {
      // Cursor surfaces explicit tool failures via this dedicated
      // event in addition to (potentially redundantly with)
      // postToolUse outcome=failed. We capture both so the
      // dashboard's error timeline catches every failure regardless
      // of which path Cursor takes for a given tool.
      const result = parseCursorToolOutput(evt.tool_output)
      return {
        type: 'action',
        toolExecuted: evt.tool_name,
        outcome: 'failed',
        errorMessage:
          result.errorMessage ?? evt.tool_output ?? 'tool execution failed',
        durationMs:
          typeof evt.duration === 'number' ? evt.duration : undefined,
        model: normaliseCursorModel(evt.model),
        traceId,
        metadata: {
          ...baseMetadata,
          kind: 'post_tool_use_failure',
          toolUseId: evt.tool_use_id,
          toolInput: evt.tool_input,
        },
      }
    }

    case 'subagentStart': {
      return {
        type: 'decision',
        reasoning: `Subagent started${evt.subagent_type ? ` (${evt.subagent_type})` : ''}`,
        outcome: 'success',
        model: normaliseCursorModel(evt.model),
        traceId,
        metadata: {
          ...baseMetadata,
          kind: 'subagent_start',
          subagentType: evt.subagent_type,
          subagentInput: evt.subagent_input,
          parentSessionId: evt.parent_session_id,
        },
      }
    }

    case 'subagentStop': {
      const tokens = cursorTokens(evt)
      return {
        type: 'decision',
        reasoning: `Subagent finished${evt.subagent_type ? ` (${evt.subagent_type})` : ''}`,
        outcome: evt.status === 'aborted' ? 'failed' : 'success',
        durationMs:
          typeof evt.duration === 'number' ? evt.duration : undefined,
        model: normaliseCursorModel(evt.model),
        traceId,
        tokens: tokens?.tokens,
        metadata: {
          ...baseMetadata,
          kind: 'subagent_stop',
          subagentType: evt.subagent_type,
          subagentOutput: evt.subagent_output,
          status: evt.status,
          parentSessionId: evt.parent_session_id,
          tokensBreakdown: tokens?.breakdown,
        },
      }
    }

    case 'preCompact': {
      return {
        type: 'decision',
        reasoning: 'Context compaction triggered',
        outcome: 'success',
        model: normaliseCursorModel(evt.model),
        traceId,
        metadata: {
          ...baseMetadata,
          kind: 'pre_compact',
          trigger: evt.trigger,
        },
      }
    }

    case 'afterAgentThought': {
      // Cursor's analogue of Claude Code's thinking blocks. Stored
      // in metadata.thinkingPreview (which the dashboard renders as
      // a maskable block, same as Claude). reasoning is a short
      // marker so the timeline doesn't leak the chain-of-thought
      // inline.
      const text = evt.thought ?? evt.text ?? ''
      return {
        type: 'decision',
        reasoning: 'agent thought captured',
        outcome: 'success',
        model: normaliseCursorModel(evt.model),
        traceId,
        metadata: {
          ...baseMetadata,
          kind: 'agent_thought',
          ...(text ? { thinkingPreview: text } : {}),
          thought_length: text.length,
        },
      }
    }
  }
}
