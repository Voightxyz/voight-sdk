/**
 * `voight hook` — invoked by Claude Code's settings.json hooks.
 *
 * Claude Code feeds the hook a JSON object on stdin:
 *   {
 *     hook_event_name: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | ...,
 *     session_id: string,
 *     cwd: string,
 *     transcript_path: string,
 *     tool_name?: string,
 *     tool_input?: object,
 *     tool_response?: object,
 *     prompt?: string,
 *     ...
 *   }
 *
 * We map that into a Voight event payload and POST via the Voight
 * client, so this hook benefits from every retry / sanitization the
 * library already does.
 *
 * Critical contract: never crash the host editor. Hooks failing fast
 * is fine; hooks raising stack traces in the user's terminal is not.
 * We log diagnostics on stderr only when DEBUG=1.
 */

import { Voight } from './index.js'

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
}

const DEBUG = process.env.VOIGHT_DEBUG === '1' || process.env.DEBUG === '1'

function dbg(...args: unknown[]) {
  if (DEBUG) console.error('[voight-hook]', ...args)
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

function mapEvent(evt: HookEvent): {
  type: 'decision' | 'action' | 'error'
  reasoning?: string
  toolExecuted?: string
  outcome: 'success' | 'failed' | 'pending'
  metadata: Record<string, unknown>
} {
  const event = evt.hook_event_name ?? 'unknown'
  const meta: Record<string, unknown> = {
    source: 'claude-code',
    hookEvent: event,
    sessionId: evt.session_id,
    cwd: evt.cwd,
  }

  switch (event) {
    case 'PreToolUse':
      return {
        type: 'action',
        toolExecuted: evt.tool_name,
        reasoning: `about to call ${evt.tool_name ?? 'tool'}`,
        outcome: 'pending',
        metadata: { ...meta, toolInput: evt.tool_input },
      }
    case 'PostToolUse': {
      const failed = !!(evt.tool_response as any)?.error
      return {
        type: 'action',
        toolExecuted: evt.tool_name,
        reasoning: `finished ${evt.tool_name ?? 'tool'}`,
        outcome: failed ? 'failed' : 'success',
        metadata: { ...meta, toolResponse: evt.tool_response },
      }
    }
    case 'UserPromptSubmit':
      return {
        type: 'decision',
        reasoning: evt.prompt?.slice(0, 800),
        outcome: 'success',
        metadata: meta,
      }
    case 'Stop':
      return {
        type: 'decision',
        reasoning: 'session stopped',
        outcome: 'success',
        metadata: { ...meta, reason: evt.reason ?? null },
      }
    default:
      return {
        type: 'decision',
        reasoning: evt.message ?? `${event}`,
        outcome: 'success',
        metadata: meta,
      }
  }
}

export async function runHook(): Promise<void> {
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
  const res = await voight.log(mapped)
  if (!res.ok) dbg('log failed:', res.error)
  else dbg('logged event', res.eventId)
}

function pathBasename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}
