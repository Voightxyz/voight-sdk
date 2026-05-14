/**
 * Tests for the pure helpers in `setup.ts`.
 *
 * `runSetup` itself is integration-shaped (readline + filesystem +
 * process.exit), so it's exercised via manual verification at
 * publish time (B.8.4). The pure helpers below cover every input
 * decision the wizard makes — if these are right, the orchestration
 * is straightforward.
 */

import { describe, it, expect } from 'vitest'

import {
  detectTarget,
  frameworkName,
  parseArgs,
  parsePrivacyChoice,
} from '../../src/setup.js'

describe('parseArgs', () => {
  it('returns all fields undefined when nothing is specified', () => {
    // Pre-0.4.3 this returned target: 'claude'. Now target stays
    // undefined so runSetup can layer detectTarget() before
    // falling back to the claude default.
    expect(parseArgs([])).toEqual({
      key: undefined,
      target: undefined,
      privacy: undefined,
    })
  })

  it('parses --key flag (space-separated and =-separated)', () => {
    expect(parseArgs(['--key', 'vk_abc'])).toMatchObject({ key: 'vk_abc' })
    expect(parseArgs(['--key=vk_abc'])).toMatchObject({ key: 'vk_abc' })
  })

  it('parses --target flag and drops unknown targets to undefined', () => {
    expect(parseArgs(['--target', 'cursor'])).toMatchObject({ target: 'cursor' })
    expect(parseArgs(['--target=codex'])).toMatchObject({ target: 'codex' })
    // Unknown target → undefined → runSetup falls back via
    // detectTarget() and then to 'claude' as last resort.
    expect(parseArgs(['--target', 'vscode'])).toMatchObject({ target: undefined })
  })

  it('parses --privacy flag (numeric and named values)', () => {
    expect(parseArgs(['--privacy', 'minimal'])).toMatchObject({
      privacy: 'minimal',
    })
    expect(parseArgs(['--privacy=full'])).toMatchObject({ privacy: 'full' })
    expect(parseArgs(['--privacy', '1'])).toMatchObject({ privacy: 'minimal' })
    expect(parseArgs(['--privacy=2'])).toMatchObject({ privacy: 'standard' })
    expect(parseArgs(['--privacy', '3'])).toMatchObject({ privacy: 'full' })
  })

  it('drops invalid --privacy values to undefined (wizard re-asks)', () => {
    expect(parseArgs(['--privacy', 'paranoid'])).toMatchObject({
      privacy: undefined,
    })
    expect(parseArgs(['--privacy=4'])).toMatchObject({ privacy: undefined })
  })

  it('combines key + target + privacy in one invocation', () => {
    expect(
      parseArgs(['--target=cursor', '--privacy=minimal', '--key', 'vk_x']),
    ).toEqual({
      key: 'vk_x',
      target: 'cursor',
      privacy: 'minimal',
    })
  })
})

describe('detectTarget', () => {
  it('returns undefined when no env signals are present', () => {
    // No detection signals → caller falls back to the historical
    // 'claude' default. Preserves pre-0.4.3 behaviour for users
    // running setup from a plain terminal.
    expect(detectTarget({})).toBeUndefined()
  })

  it('detects Cursor via CURSOR_TRACE_ID', () => {
    expect(detectTarget({ CURSOR_TRACE_ID: 'abc-123' })).toBe('cursor')
  })

  it('detects Cursor via TERM_PROGRAM=cursor', () => {
    expect(detectTarget({ TERM_PROGRAM: 'cursor' })).toBe('cursor')
  })

  it('does not match Cursor when TERM_PROGRAM is something else', () => {
    // VS Code's integrated terminal sets TERM_PROGRAM=vscode; we
    // must not misclassify that as Cursor.
    expect(detectTarget({ TERM_PROGRAM: 'vscode' })).toBeUndefined()
    expect(detectTarget({ TERM_PROGRAM: 'iTerm.app' })).toBeUndefined()
  })

  it('detects Claude Code via CLAUDECODE=1', () => {
    expect(detectTarget({ CLAUDECODE: '1' })).toBe('claude')
  })

  it('detects Claude Code via CLAUDE_CODE_SSE_PORT', () => {
    expect(detectTarget({ CLAUDE_CODE_SSE_PORT: '12345' })).toBe('claude')
  })

  it('detects Codex via CODEX_SESSION_ID', () => {
    expect(detectTarget({ CODEX_SESSION_ID: 'sess_abc' })).toBe('codex')
  })

  it('Cursor wins over Claude when both signals are present', () => {
    // The agent actually invoking the SDK is the more specific
    // signal — if you're in Cursor's terminal but Claude Code was
    // also running in the background, the npx call comes from
    // Cursor.
    expect(
      detectTarget({ CURSOR_TRACE_ID: 'x', CLAUDECODE: '1' }),
    ).toBe('cursor')
  })

  it('handles undefined env entries without crashing', () => {
    // NodeJS.ProcessEnv values are `string | undefined`; an explicit
    // `undefined` should never trigger a false positive.
    expect(
      detectTarget({
        CURSOR_TRACE_ID: undefined,
        CLAUDECODE: undefined,
        TERM_PROGRAM: undefined,
      }),
    ).toBeUndefined()
  })
})

describe('parsePrivacyChoice', () => {
  it('maps numeric menu shortcuts', () => {
    expect(parsePrivacyChoice('1')).toBe('minimal')
    expect(parsePrivacyChoice('2')).toBe('standard')
    expect(parsePrivacyChoice('3')).toBe('full')
  })

  it('accepts the level names case-insensitively', () => {
    expect(parsePrivacyChoice('minimal')).toBe('minimal')
    expect(parsePrivacyChoice('STANDARD')).toBe('standard')
    expect(parsePrivacyChoice('Full')).toBe('full')
  })

  it('returns the default on empty / whitespace-only input', () => {
    expect(parsePrivacyChoice('')).toBe('standard')
    expect(parsePrivacyChoice('   ')).toBe('standard')
  })

  it('uses the supplied default when caller overrides', () => {
    expect(parsePrivacyChoice('', 'minimal')).toBe('minimal')
    expect(parsePrivacyChoice('   ', 'full')).toBe('full')
  })

  it('returns null when caller passes default=null and input is empty', () => {
    // The CLI flag parser uses this: an empty `--privacy` value is an
    // invalid invocation, not a request for the recommended default.
    expect(parsePrivacyChoice('', null)).toBeNull()
    expect(parsePrivacyChoice('   ', null)).toBeNull()
  })

  it('returns null on garbage so the wizard can re-prompt', () => {
    expect(parsePrivacyChoice('paranoid')).toBeNull()
    expect(parsePrivacyChoice('4')).toBeNull()
    expect(parsePrivacyChoice('-1')).toBeNull()
  })
})

describe('frameworkName', () => {
  it('returns the friendly display name for each target', () => {
    // Used by the wizard's success message; before 0.4.3 the message
    // hardcoded "Claude Code" regardless of target, which led Cursor's
    // agent to misread Voight as Claude-only.
    expect(frameworkName('claude')).toBe('Claude Code')
    expect(frameworkName('cursor')).toBe('Cursor')
    expect(frameworkName('codex')).toBe('Codex')
  })
})
