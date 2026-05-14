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
  ensureCursorHook,
  frameworkName,
  generateCursorHookScript,
  parseArgs,
  parseCursorScriptEnv,
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

describe('generateCursorHookScript', () => {
  it('writes a bash wrapper exporting key + privacy then exec-ing the hook', () => {
    const out = generateCursorHookScript('vk_abc123', 'standard')
    expect(out).toContain('#!/usr/bin/env bash')
    expect(out).toContain('export VOIGHT_KEY="vk_abc123"')
    expect(out).toContain('export VOIGHT_PRIVACY="standard"')
    expect(out).toContain('exec npx -y @voightxyz/sdk hook')
  })

  it('reflects whichever privacy level is passed', () => {
    expect(generateCursorHookScript('vk_x', 'minimal')).toContain(
      'export VOIGHT_PRIVACY="minimal"',
    )
    expect(generateCursorHookScript('vk_x', 'full')).toContain(
      'export VOIGHT_PRIVACY="full"',
    )
  })
})

describe('parseCursorScriptEnv', () => {
  it('extracts both key and privacy from a generated script', () => {
    const script = generateCursorHookScript('vk_xyz', 'standard')
    expect(parseCursorScriptEnv(script)).toEqual({
      key: 'vk_xyz',
      privacy: 'standard',
    })
  })

  it('returns undefined fields when nothing matches', () => {
    expect(parseCursorScriptEnv('echo hi')).toEqual({
      key: undefined,
      privacy: undefined,
    })
  })

  it('drops privacy when the value is not a known level', () => {
    // A stale script that somehow has an unknown level should fall
    // through to the wizard's default rather than crash or be trusted.
    const script =
      '#!/usr/bin/env bash\nexport VOIGHT_KEY="vk_x"\nexport VOIGHT_PRIVACY="paranoid"\n'
    expect(parseCursorScriptEnv(script)).toEqual({
      key: 'vk_x',
      privacy: undefined,
    })
  })

  it('round-trips through generateCursorHookScript', () => {
    // The two halves of the adapter must stay in sync: whatever
    // generate writes, parse must read back. Guards against future
    // edits to one half forgetting the other.
    const key = 'vk_round-trip-test'
    const privacy = 'minimal'
    const parsed = parseCursorScriptEnv(generateCursorHookScript(key, privacy))
    expect(parsed).toEqual({ key, privacy })
  })
})

describe('ensureCursorHook', () => {
  it('adds a fresh entry when the event has no hooks at all', () => {
    const hooks: Record<string, unknown[]> = {}
    const result = ensureCursorHook(hooks, 'preToolUse')
    expect(result).toBe('added')
    expect(hooks.preToolUse).toEqual([
      { command: './hooks/voight.sh', failClosed: false },
    ])
  })

  it('preserves unrelated entries the user has configured', () => {
    const hooks: Record<string, unknown[]> = {
      preToolUse: [{ command: './hooks/format.sh' }],
    }
    ensureCursorHook(hooks, 'preToolUse')
    expect(hooks.preToolUse).toHaveLength(2)
    expect((hooks.preToolUse as any)[0].command).toBe('./hooks/format.sh')
    expect((hooks.preToolUse as any)[1].command).toBe('./hooks/voight.sh')
  })

  it('does not duplicate Voight when re-running setup', () => {
    const hooks: Record<string, unknown[]> = {
      preToolUse: [{ command: './hooks/voight.sh', failClosed: false }],
    }
    const result = ensureCursorHook(hooks, 'preToolUse')
    expect(result).toBe('unchanged')
    expect(hooks.preToolUse).toHaveLength(1)
  })

  it('updates legacy direct-npx Voight entries to point at the wrapper', () => {
    // Older SDK or hand-written installs may have inserted a direct
    // 'npx -y @voightxyz/sdk hook' command. Upgrade in place rather
    // than appending a duplicate.
    const hooks: Record<string, unknown[]> = {
      preToolUse: [{ command: 'npx -y @voightxyz/sdk hook' }],
    }
    const result = ensureCursorHook(hooks, 'preToolUse')
    expect(result).toBe('updated')
    expect((hooks.preToolUse as any)[0].command).toBe('./hooks/voight.sh')
    expect(hooks.preToolUse).toHaveLength(1)
  })

  it('resets a malformed (non-array) entry to a fresh array', () => {
    // Defensive: if hooks.json got hand-edited into a broken shape,
    // we still succeed in wiring Voight rather than crashing.
    const hooks: Record<string, unknown[]> = {
      preToolUse: 'not an array' as unknown as unknown[],
    }
    const result = ensureCursorHook(hooks, 'preToolUse')
    expect(result).toBe('added')
    expect(Array.isArray(hooks.preToolUse)).toBe(true)
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
