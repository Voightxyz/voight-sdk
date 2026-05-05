/**
 * Permission-denial detection for Claude Code tool calls.
 *
 * Why this exists: when a tool is *blocked* (user denies the
 * approval prompt, settings forbid it, sandbox refuses, hook returns
 * `decision: "block"`) the tool never runs but Claude Code still
 * fires `PostToolUse` with an error-shaped `tool_response`. From the
 * dashboard's perspective these look identical to a tool that *did
 * run and crashed* — both emit `outcome: "failed"`. That conflation
 * hides a useful signal: what the agent *tried* but wasn't allowed
 * to do.
 *
 * This module classifies the failure into one of four denial types
 * (or null when the failure looks like a real runtime error) so the
 * SDK can stamp `metadata.denial` and the web can render a distinct
 * DENIED row in the timeline.
 *
 * Detection strategy: regex over the tool_response error message.
 * Patterns are intentionally conservative — we'd rather miss a
 * denial and render it as a normal error than promote a real Bash
 * "permission denied" into a fake denial event. The runtime can add
 * looser fallback rules later once we see more shapes in the wild.
 */

export type DenialType =
  /** User clicked "no" on the interactive approval prompt. */
  | 'user_rejected'
  /** Blocked before running by `~/.claude/settings.json` or per-project policy. */
  | 'settings_blocked'
  /** OS-level / sandbox restriction (path outside allowed dirs, etc.). */
  | 'sandbox_denied'
  /** Tool needed approval but the session is non-interactive
   *  (headless / CI), so it never got one. */
  | 'requires_approval'
  /** A `PreToolUse` hook returned `decision: "block"`. */
  | 'hook_blocked'

export type DenialInfo = {
  /** Categorical type — drives badge colour and aggregation. */
  type: DenialType
  /** Original message from the tool_response, truncated. Used in
   *  the dashboard tooltip + side panel detail. */
  reason: string
  /** Tool the agent asked for. Lifted from the PreToolUse tool_name. */
  requestedTool: string
}

/** First match wins — order matters because phrases overlap (a hook
 * block sometimes echoes "user rejected" wording). More specific
 * markers should appear earlier. */
const PATTERNS: { type: DenialType; rx: RegExp }[] = [
  // Hook blocks — `PreToolUse` returns decision: "block". Claude Code
  // surfaces this with explicit "blocked by hook" / "hook returned"
  // wording.
  {
    type: 'hook_blocked',
    rx: /(blocked\s+by\s+(a\s+)?hook|hook\s+(returned|decided|blocked)|pretooluse\s+hook)/i,
  },

  // Settings / policy blocks — user has configured the tool to
  // never run, or restricted it to certain paths.
  {
    type: 'settings_blocked',
    rx: /(blocked\s+by\s+(settings|policy|configuration)|tool\s+is\s+not\s+allowed|disallowed\s+by\s+(settings|policy)|deny\s+rule|forbidden\s+by\s+(settings|policy))/i,
  },

  // Sandbox / path restrictions — Claude Code's own boundary, not
  // the OS's "permission denied" (which is a real Bash failure).
  // Distinct keywords: "outside allowed", "sandbox refused",
  // "path not permitted".
  {
    type: 'sandbox_denied',
    rx: /(outside\s+(the\s+)?(allowed|permitted)\s+(dir|path)|sandbox\s+(refused|blocked|denied)|path\s+not\s+(allowed|permitted)|not\s+(in\s+)?the\s+allowed\s+(paths|directories))/i,
  },

  // Headless / non-interactive runs that need approval but can't
  // get one. Claude Code refers to these as "requires approval" or
  // "non-interactive".
  {
    type: 'requires_approval',
    rx: /(requires\s+(user\s+)?(approval|permission|consent)|approval\s+required|non[\s-]?interactive\s+(mode|session))/i,
  },

  // User-driven rejection — the most common case. Claude Code emits
  // wording like "user rejected the tool call" / "user did not
  // approve". We check this last because the previous patterns can
  // also include the word "user" coincidentally.
  {
    type: 'user_rejected',
    rx: /(user\s+(rejected|denied|did\s+not\s+approve|cancel(?:l)?ed|declined))/i,
  },
]

/**
 * Classify a failed tool_response as a permission denial, or return
 * null when the failure looks like a real runtime error.
 *
 * `errorMessage` should be the same string `detectFailure` already
 * surfaces — keeps the two functions aligned and avoids re-parsing
 * the tool_response shape twice.
 */
export function detectDenial(
  toolName: string | undefined,
  errorMessage: string | undefined,
): DenialInfo | null {
  if (!errorMessage) return null
  const tool = toolName && toolName.trim() ? toolName : 'unknown'

  for (const { type, rx } of PATTERNS) {
    if (rx.test(errorMessage)) {
      return {
        type,
        reason: errorMessage.slice(0, 400),
        requestedTool: tool,
      }
    }
  }

  return null
}

/** Stable list of all known denial types. Lets the dashboard build
 * a filter dropdown without hard-coding. */
export const DENIAL_TYPES: DenialType[] = [
  'user_rejected',
  'settings_blocked',
  'sandbox_denied',
  'requires_approval',
  'hook_blocked',
]
