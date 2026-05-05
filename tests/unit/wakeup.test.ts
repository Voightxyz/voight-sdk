/**
 * Tests for the wakeup-tracking module — ties `ScheduleWakeup` tool
 * calls to the `UserPromptSubmit` they later trigger so the dashboard
 * can distinguish system-initiated prompts from real user messages.
 *
 * The module persists wakeup records to a tmpdir directory keyed by
 * session_id. Each test isolates state by overriding HOME (which is
 * not used here) — instead we rely on unique session_ids so files
 * never collide between tests.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'

import {
  consumeWakeupForPrompt,
  isSentinelPrompt,
  recordWakeup,
  _internals,
} from '../../src/wakeup.js'

function freshSessionId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

beforeEach(() => {
  // Clean any leftover state from previous runs. The directory is
  // shared across tests but each test uses a unique session_id, so
  // this is just a sanity sweep.
  if (existsSync(_internals.WAKEUP_DIR)) {
    rmSync(_internals.WAKEUP_DIR, { recursive: true, force: true })
  }
})

describe('recordWakeup', () => {
  it('persists prompt + delay + reason for a session', () => {
    const sid = freshSessionId()
    const rec = recordWakeup(sid, {
      prompt: 'check the build',
      delaySeconds: 600,
      reason: 'long bun build',
    })
    expect(rec).not.toBeNull()
    expect(rec?.prompt).toBe('check the build')
    expect(rec?.delaySeconds).toBe(600)
    expect(rec?.reason).toBe('long bun build')
    expect(rec?.scheduledAt).toBeGreaterThan(0)
  })

  it('returns null when prompt is missing', () => {
    const sid = freshSessionId()
    const rec = recordWakeup(sid, { delaySeconds: 60 })
    expect(rec).toBeNull()
  })

  it('returns null when delaySeconds is missing', () => {
    const sid = freshSessionId()
    const rec = recordWakeup(sid, { prompt: 'foo' })
    expect(rec).toBeNull()
  })

  it('returns null when sessionId is missing', () => {
    const rec = recordWakeup(undefined, {
      prompt: 'foo',
      delaySeconds: 60,
    })
    expect(rec).toBeNull()
  })

  it('overwrites an existing record (most recent wins)', () => {
    const sid = freshSessionId()
    recordWakeup(sid, { prompt: 'first', delaySeconds: 60 })
    const second = recordWakeup(sid, {
      prompt: 'second',
      delaySeconds: 120,
      reason: 'updated',
    })
    expect(second?.prompt).toBe('second')
    // Only the second one should match a consume call.
    const match = consumeWakeupForPrompt(sid, 'second')
    expect(match).not.toBeNull()
    expect(match?.delaySeconds).toBe(120)
  })
})

describe('consumeWakeupForPrompt', () => {
  it('returns null when no record exists', () => {
    const sid = freshSessionId()
    const match = consumeWakeupForPrompt(sid, 'anything')
    expect(match).toBeNull()
  })

  it('matches an exact prompt and consumes the record', () => {
    const sid = freshSessionId()
    recordWakeup(sid, {
      prompt: 'rerun the tests',
      delaySeconds: 300,
      reason: 'flaky CI',
    })
    const match = consumeWakeupForPrompt(sid, 'rerun the tests')
    expect(match).not.toBeNull()
    expect(match?.delaySeconds).toBe(300)
    expect(match?.reason).toBe('flaky CI')
    expect(match?.sentinel).toBe(false)
    // Second consume should be null because the entry was deleted.
    const second = consumeWakeupForPrompt(sid, 'rerun the tests')
    expect(second).toBeNull()
  })

  it('matches any prompt when wakeup is a sentinel', () => {
    const sid = freshSessionId()
    recordWakeup(sid, {
      prompt: '<<autonomous-loop-dynamic>>',
      delaySeconds: 60,
      reason: 'idle tick',
    })
    const match = consumeWakeupForPrompt(
      sid,
      'totally different resolved prompt text',
    )
    expect(match).not.toBeNull()
    expect(match?.sentinel).toBe(true)
    expect(match?.reason).toBe('idle tick')
  })

  it('does not match when prompts differ and wakeup is not a sentinel', () => {
    const sid = freshSessionId()
    recordWakeup(sid, {
      prompt: 'expected prompt',
      delaySeconds: 60,
    })
    const match = consumeWakeupForPrompt(sid, 'unexpected human message')
    expect(match).toBeNull()
    // Record should still exist — not consumed.
    const second = consumeWakeupForPrompt(sid, 'expected prompt')
    expect(second).not.toBeNull()
  })

  it('isolates records by session_id', () => {
    const sidA = freshSessionId()
    const sidB = freshSessionId()
    recordWakeup(sidA, { prompt: 'A', delaySeconds: 60 })
    const match = consumeWakeupForPrompt(sidB, 'A')
    expect(match).toBeNull()
    // Record for A should still be there.
    const otherMatch = consumeWakeupForPrompt(sidA, 'A')
    expect(otherMatch).not.toBeNull()
  })

  it('reports actualDelayMs as the wall-clock gap from schedule to fire', async () => {
    const sid = freshSessionId()
    recordWakeup(sid, { prompt: 'p', delaySeconds: 60 })
    await new Promise((r) => setTimeout(r, 25))
    const match = consumeWakeupForPrompt(sid, 'p')
    expect(match?.actualDelayMs).toBeGreaterThanOrEqual(20)
  })
})

describe('isSentinelPrompt', () => {
  it('returns true for known sentinels', () => {
    expect(isSentinelPrompt('<<autonomous-loop-dynamic>>')).toBe(true)
    expect(isSentinelPrompt('<<autonomous-loop>>')).toBe(true)
  })

  it('returns false for everything else', () => {
    expect(isSentinelPrompt('hello world')).toBe(false)
    expect(isSentinelPrompt('')).toBe(false)
    expect(isSentinelPrompt(undefined)).toBe(false)
    // Near-misses must not match (no fuzzy detection — exact set only).
    expect(isSentinelPrompt('<<autonomous-loop-dynamic')).toBe(false)
    expect(isSentinelPrompt(' <<autonomous-loop-dynamic>> ')).toBe(false)
  })
})

describe('expiry', () => {
  it('drops records past schedule + delay + grace window', () => {
    const sid = freshSessionId()
    // Manually write an aged record by going through recordWakeup
    // and then mutating the file's scheduledAt to the past. That's
    // simpler than mocking Date.now() across imports.
    recordWakeup(sid, { prompt: 'old', delaySeconds: 60 })

    // Read, age it past the grace window (35 minutes total), write back.
    const path = _internals.wakeupFile(sid)
    const fs = require('node:fs') as typeof import('node:fs')
    const raw = JSON.parse(fs.readFileSync(path, 'utf-8'))
    raw.scheduledAt =
      Date.now() - (60 * 1000 + _internals.POST_FIRE_GRACE_MS + 5_000)
    fs.writeFileSync(path, JSON.stringify(raw))

    const match = consumeWakeupForPrompt(sid, 'old')
    expect(match).toBeNull()
    // And the file should now be deleted.
    expect(fs.existsSync(path)).toBe(false)
  })
})
