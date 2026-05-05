/**
 * Wakeup tracking — links `ScheduleWakeup` tool calls to the
 * `UserPromptSubmit` they later trigger.
 *
 * Why: when an agent calls `ScheduleWakeup`, Claude Code later fires
 * a `UserPromptSubmit` hook event with the scheduled prompt. From the
 * hook's point of view the prompt looks identical to a real human
 * prompt — same shape, same fields. Without help, the dashboard
 * timeline shows wakeups as user prompts, which is misleading.
 *
 * Mechanism:
 *   1. On `PreToolUse(ScheduleWakeup)` we record the scheduled prompt
 *      + delaySeconds + reason to tmpdir keyed by session_id.
 *   2. On `UserPromptSubmit` we look for a pending wakeup for that
 *      session and try to match. If matched we mark the event as
 *      `source: 'system'` with `wakeup: { delaySeconds, reason }`.
 *
 * Matching rules (in priority order):
 *   - Exact prompt match → consume.
 *   - Sentinel wakeup (`<<autonomous-loop-dynamic>>` etc.) → any
 *     prompt within the time window matches; the runtime resolves
 *     the sentinel to actual text at fire time, so we can't compare
 *     literally.
 *   - Otherwise → no match (treat as a real user prompt).
 *
 * Expiry: a pending wakeup TTLs out 30 minutes past its expected fire
 * time. Stops a stale entry from claiming a real prompt later.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

const WAKEUP_DIR = join(tmpdir(), 'voight-wakeups')

/** Slack window after expected fire time. Wakeup might be a few minutes
 * late from the runtime's side — we still want to associate it. */
const POST_FIRE_GRACE_MS = 30 * 60 * 1000

/** Sentinels the runtime resolves into real prompt text at fire time.
 * Listed in the SDK system prompt for `ScheduleWakeup` /
 * `<<autonomous-loop>>` flows. When the recorded prompt is a sentinel
 * we accept any prompt that arrives within the time window. */
const SENTINELS = new Set([
  '<<autonomous-loop-dynamic>>',
  '<<autonomous-loop>>',
])

export type WakeupRecord = {
  prompt: string
  delaySeconds: number
  reason?: string
  /** Wall-clock ms when ScheduleWakeup was invoked. */
  scheduledAt: number
}

export type WakeupMatch = {
  delaySeconds: number
  reason?: string
  /** ms between schedule and fire. Useful for telemetry. */
  actualDelayMs: number
  /** True when matched via sentinel rather than exact prompt. */
  sentinel: boolean
}

function wakeupFile(sessionId: string | undefined): string {
  return join(WAKEUP_DIR, `${(sessionId ?? 'unknown').slice(0, 64)}.json`)
}

function safeNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function safeString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Record a wakeup scheduled by the agent. Called from PreToolUse when
 * the tool name is `ScheduleWakeup`. Idempotent — overwrites any
 * existing pending wakeup for the same session (the most recent
 * schedule wins, which matches `ScheduleWakeup` semantics: each call
 * replaces the prior schedule for that session).
 */
export function recordWakeup(
  sessionId: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): WakeupRecord | null {
  if (!sessionId) return null
  const prompt = safeString(toolInput?.prompt)
  const delaySeconds = safeNumber(toolInput?.delaySeconds)
  if (!prompt || delaySeconds === undefined) return null

  const record: WakeupRecord = {
    prompt,
    delaySeconds,
    reason: safeString(toolInput?.reason),
    scheduledAt: Date.now(),
  }

  try {
    mkdirSync(WAKEUP_DIR, { recursive: true })
    writeFileSync(wakeupFile(sessionId), JSON.stringify(record))
  } catch {
    // tmpdir unwritable — silently degrade. Wakeups won't be tagged
    // but logging continues.
    return null
  }

  return record
}

function readWakeup(sessionId: string | undefined): WakeupRecord | null {
  if (!sessionId) return null
  const path = wakeupFile(sessionId)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<WakeupRecord>
    if (
      typeof raw.prompt !== 'string' ||
      typeof raw.delaySeconds !== 'number' ||
      typeof raw.scheduledAt !== 'number'
    ) {
      return null
    }
    return {
      prompt: raw.prompt,
      delaySeconds: raw.delaySeconds,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      scheduledAt: raw.scheduledAt,
    }
  } catch {
    return null
  }
}

function deleteWakeup(sessionId: string | undefined): void {
  if (!sessionId) return
  try {
    unlinkSync(wakeupFile(sessionId))
  } catch {
    /* ignore */
  }
}

/**
 * Try to match an incoming UserPromptSubmit prompt against a pending
 * wakeup for this session. On match the entry is consumed (deleted).
 * Returns the wakeup metadata so the caller can attach it to the event.
 *
 * Returns null when:
 *   - no pending wakeup exists for this session
 *   - the entry expired (past schedule + delay + grace)
 *   - the prompt does not match (and it isn't a sentinel wakeup)
 */
export function consumeWakeupForPrompt(
  sessionId: string | undefined,
  prompt: string | undefined,
): WakeupMatch | null {
  const rec = readWakeup(sessionId)
  if (!rec) return null

  const now = Date.now()
  const expectedFireAt = rec.scheduledAt + rec.delaySeconds * 1000
  const expiresAt = expectedFireAt + POST_FIRE_GRACE_MS

  if (now > expiresAt) {
    // Stale — wakeup never fired (session ended, user interrupted).
    deleteWakeup(sessionId)
    return null
  }

  const sentinel = SENTINELS.has(rec.prompt)
  const exactMatch = typeof prompt === 'string' && prompt === rec.prompt

  if (!sentinel && !exactMatch) {
    // Prompt doesn't look like the scheduled one. Leave the entry —
    // the real wakeup might still arrive. (User typed something while
    // waiting for the wakeup to fire is a rare edge case; even if we
    // skip it here, the wakeup will match on its next firing.)
    return null
  }

  // Match. Consume.
  deleteWakeup(sessionId)
  return {
    delaySeconds: rec.delaySeconds,
    reason: rec.reason,
    actualDelayMs: now - rec.scheduledAt,
    sentinel,
  }
}

/**
 * Probabilistic GC of stale wakeup entries. Same pattern as the
 * duration cache — 5% of invocations sweep. Idempotent, swallows all
 * errors.
 */
export function gcWakeupDir(): void {
  if (Math.random() > 0.05) return
  try {
    if (!existsSync(WAKEUP_DIR)) return
    const now = Date.now()
    for (const f of readdirSync(WAKEUP_DIR)) {
      const p = join(WAKEUP_DIR, f)
      try {
        const st = statSync(p)
        // Drop files older than 24h regardless of contents.
        if (now - st.mtimeMs > 24 * 60 * 60 * 1000) unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

// Test-only helpers. Marked with leading underscore so callers know
// they're internal; vitest imports them directly.
export const _internals = {
  WAKEUP_DIR,
  POST_FIRE_GRACE_MS,
  SENTINELS,
  wakeupFile,
}
